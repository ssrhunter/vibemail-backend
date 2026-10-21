import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

const hoisted = vi.hoisted(() => {
  const modifyMock = vi.fn(async () => ({ data: {} }));
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
  return { modifyMock, FakeOAuth2Client };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: hoisted.FakeOAuth2Client },
    gmail: () => ({ users: { messages: { modify: hoisted.modifyMock } } }),
  },
}));

import handler from '../../../api/v1/messages/read';
import { createMockReqRes } from '../../helpers/http';
import { getServiceClient, upsertUserTokens, upsertMessages } from '../../../src/db';
import * as dbModule from '../../../src/db';
import { encrypt } from '../../../src/providers/gmail/encryption';
import { signSessionToken } from '../../../src/middleware/auth';

interface ErrorBody {
  error: { code: string; message: string };
}
interface ReadSuccessBody {
  data: { succeeded: string[]; failed: { id: string; code: string }[] };
}

describe('PATCH /api/v1/messages/read', () => {
  const createdGoogleIds: string[] = [];

  async function seedUserWithMessage(gmailId: string): Promise<string> {
    const googleId = `test-${randomUUID()}`;
    await upsertUserTokens({
      googleId,
      email: `${googleId}@example.com`,
      accessTokenEncrypted: encrypt('access-token'),
      refreshTokenEncrypted: encrypt('refresh-token'),
      tokenExpiry: new Date(Date.now() + 3_600_000),
    });
    await upsertMessages([
      {
        gmail_id: gmailId,
        google_id: googleId,
        thread_id: gmailId,
        subject: 'Hi',
        from_address: 'a@example.com',
        to_address: 'b@example.com',
        snippet: 'hi',
        body_plain: 'hi',
        body_html: null,
        label_ids: ['INBOX', 'UNREAD'],
        is_read: false,
        is_starred: false,
        sent_at: new Date().toISOString(),
      },
    ]);
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
    hoisted.modifyMock.mockResolvedValue({ data: {} });
  });

  it('200s, removes UNREAD via Gmail, and updates is_read on the happy path', async () => {
    const gmailId = `msg-${randomUUID()}`;
    const googleId = await seedUserWithMessage(gmailId);
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: { messageIds: [gmailId] },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(200);
    expect((capture.body as ReadSuccessBody).data.succeeded).toEqual([gmailId]);
    expect((capture.body as ReadSuccessBody).data.failed).toEqual([]);

    const supabase = getServiceClient();
    const { data: row } = await supabase.from('messages').select('is_read').eq('gmail_id', gmailId).single();
    expect(row).not.toBeNull();
    expect(row?.is_read).toBe(true);
  });

  it('reports a per-id Gmail failure inside the 200 response failed[] array with code GMAIL_API_ERROR, not as an HTTP error', async () => {
    const gmailId = `msg-${randomUUID()}`;
    const googleId = await seedUserWithMessage(gmailId);
    hoisted.modifyMock.mockRejectedValueOnce(new Error('simulated per-id Gmail failure'));
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: { messageIds: [gmailId] },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(200); // contract.md §2.4: batch itself doesn't fail at the HTTP level
    const body = capture.body as ReadSuccessBody;
    expect(body.data.succeeded).toEqual([]);
    expect(body.data.failed).toEqual([{ id: gmailId, code: 'GMAIL_API_ERROR' }]);
  });

  it('UNAUTHENTICATED (401) with no Authorization header', async () => {
    const { req, res, capture } = createMockReqRes({ method: 'PATCH', body: { messageIds: ['x'] } });
    await handler(req, res);

    expect(capture.statusCode).toBe(401);
    expect((capture.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('VALIDATION_ERROR (400) when messageIds is empty', async () => {
    const googleId = await seedUserWithMessage(`msg-${randomUUID()}`);
    const { token } = signSessionToken(googleId);
    const { req, res, capture } = createMockReqRes({
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: { messageIds: [] },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('INTERNAL_ERROR (500) on an unexpected non-Gmail failure', async () => {
    const gmailId = `msg-${randomUUID()}`;
    const googleId = await seedUserWithMessage(gmailId);
    const { token } = signSessionToken(googleId);
    vi.spyOn(dbModule, 'getUser').mockRejectedValueOnce(new Error('simulated internal failure'));

    const { req, res, capture } = createMockReqRes({
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: { messageIds: [gmailId] },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(500);
    expect((capture.body as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });
});
