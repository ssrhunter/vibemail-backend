import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { gmail_v1 } from 'googleapis';

const hoisted = vi.hoisted(() => {
  let sendShouldThrow = false;
  let sentId = 'sent-message-id';

  // Hand-rolled instead of `extends EventEmitter`: referencing an imported value from
  // inside vi.hoisted() hits a TDZ error, since Vitest hoists vi.mock/vi.hoisted calls
  // above even unrelated import initialization.
  class FakeOAuth2Client {
    private tokenListeners: Array<(tokens: Record<string, unknown>) => void> = [];
    public credentials: Record<string, unknown> = {};
    on(event: string, listener: (tokens: Record<string, unknown>) => void): this {
      if (event === 'tokens') this.tokenListeners.push(listener);
      return this;
    }
    emit(event: string, payload: Record<string, unknown>): void {
      if (event === 'tokens') {
        for (const listener of this.tokenListeners) listener(payload);
      }
    }
    generateAuthUrl(): string {
      return 'mock-url';
    }
    async getToken() {
      return { tokens: {} };
    }
    setCredentials(creds: Record<string, unknown>): void {
      this.credentials = creds;
    }
    async verifyIdToken() {
      return { getPayload: () => ({}) };
    }
    async refreshAccessToken() {
      return { credentials: {} };
    }
  }

  return {
    FakeOAuth2Client,
    sendMock: vi.fn(async () => {
      if (sendShouldThrow) throw new Error('simulated Gmail send failure');
      return { data: { id: sentId, threadId: sentId } };
    }),
    getMock: vi.fn(),
    setSendShouldThrow: (v: boolean) => {
      sendShouldThrow = v;
    },
    setSentId: (id: string) => {
      sentId = id;
    },
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: hoisted.FakeOAuth2Client },
    gmail: () => ({
      users: {
        messages: { send: hoisted.sendMock, get: hoisted.getMock },
      },
    }),
  },
}));

import handler from '../../../api/v1/messages/send';
import { createMockReqRes } from '../../helpers/http';
import { getServiceClient } from '../../../src/db/client';
import { upsertUserTokens } from '../../../src/db/users';
import * as messagesDb from '../../../src/db/messages';
import { encrypt } from '../../../src/providers/gmail/encryption';
import { signSessionToken } from '../../../src/middleware/auth';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown[] };
}
interface SuccessBody {
  data: { id: string; subject: string | null };
}

function fullSentMessage(id: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: id,
    labelIds: ['SENT'],
    snippet: 'Hello',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Hi there' },
        { name: 'From', value: 'me@example.com' },
        { name: 'To', value: 'recipient@example.com' },
      ],
      body: { data: Buffer.from('Hello', 'utf8').toString('base64url') },
    },
  };
}

describe('POST /api/v1/messages', () => {
  const createdGoogleIds: string[] = [];

  async function seedUser(): Promise<string> {
    const googleId = `test-${randomUUID()}`;
    await upsertUserTokens({
      googleId,
      email: `${googleId}@example.com`,
      accessTokenEncrypted: encrypt('access-token'),
      refreshTokenEncrypted: encrypt('refresh-token'),
      tokenExpiry: new Date(Date.now() + 3_600_000),
    });
    createdGoogleIds.push(googleId);
    return googleId;
  }

  afterEach(async () => {
    const supabase = getServiceClient();
    for (const googleId of createdGoogleIds) {
      await supabase.from('messages').delete().eq('google_id', googleId);
      await supabase.from('users').delete().eq('google_id', googleId);
    }
    createdGoogleIds.length = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    hoisted.setSendShouldThrow(false);
  });

  it('201s and stores the sent message on the happy path', async () => {
    const googleId = await seedUser();
    const sentId = `sent-${randomUUID()}`;
    hoisted.setSentId(sentId);
    hoisted.getMock.mockResolvedValue({ data: fullSentMessage(sentId) });
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { to: ['recipient@example.com'], subject: 'Hi there', bodyText: 'Hello' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(201);
    expect((capture.body as SuccessBody).data).toMatchObject({ id: sentId, subject: 'Hi there' });
  });

  it('UNAUTHENTICATED (401) with no Authorization header', async () => {
    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      body: { to: ['x@example.com'], subject: 'Hi', bodyText: 'Hello' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(401);
    expect((capture.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('VALIDATION_ERROR (400) on an invalid body (missing to/subject/body)', async () => {
    const googleId = await seedUser();
    const { token } = signSessionToken(googleId);
    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect((capture.body as ErrorBody).error.details?.length).toBeGreaterThan(0);
  });

  it('GMAIL_SEND_FAILED (502) when Gmail rejects the send', async () => {
    const googleId = await seedUser();
    hoisted.setSendShouldThrow(true);
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { to: ['recipient@example.com'], subject: 'Hi', bodyText: 'Hello' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(502);
    expect((capture.body as ErrorBody).error.code).toBe('GMAIL_SEND_FAILED');
  });

  it('INTERNAL_ERROR (500) on an unexpected non-Gmail failure', async () => {
    const googleId = await seedUser();
    const sentId = `sent-${randomUUID()}`;
    hoisted.setSentId(sentId);
    hoisted.getMock.mockResolvedValue({ data: fullSentMessage(sentId) });
    vi.spyOn(messagesDb, 'upsertMessages').mockRejectedValueOnce(new Error('simulated internal failure'));
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { to: ['recipient@example.com'], subject: 'Hi', bodyText: 'Hello' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(500);
    expect((capture.body as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });
});
