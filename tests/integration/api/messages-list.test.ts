import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

const hoisted = vi.hoisted(() => {
  let listShouldThrow = false;

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
    messagesListMock: vi.fn(async () => {
      if (listShouldThrow) throw new Error('simulated Gmail upstream failure');
      return { data: { messages: [], nextPageToken: null } };
    }),
    messagesGetMock: vi.fn(),
    getProfileMock: vi.fn(async () => ({ data: { historyId: '1' } })),
    setListShouldThrow: (v: boolean) => {
      listShouldThrow = v;
    },
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: hoisted.FakeOAuth2Client },
    gmail: () => ({
      users: {
        messages: { list: hoisted.messagesListMock, get: hoisted.messagesGetMock },
        getProfile: hoisted.getProfileMock,
      },
    }),
  },
}));

import handler from '../../../api/v1/messages/index';
import { createMockReqRes } from '../../helpers/http';
import { getServiceClient } from '../../../src/db/client';
import { upsertUserTokens, updateHistoryId } from '../../../src/db/users';
import * as usersDb from '../../../src/db/users';
import { upsertMessages } from '../../../src/db/messages';
import { encrypt } from '../../../src/providers/gmail/encryption';
import { signSessionToken } from '../../../src/middleware/auth';

interface ErrorBody {
  error: { code: string; message: string };
}
interface SuccessBody {
  data: unknown[];
}

describe('GET /api/v1/messages', () => {
  const createdGoogleIds: string[] = [];

  async function seedUser(historyId: string | null): Promise<string> {
    const googleId = `test-${randomUUID()}`;
    await upsertUserTokens({
      googleId,
      email: `${googleId}@example.com`,
      accessTokenEncrypted: encrypt('access-token'),
      refreshTokenEncrypted: encrypt('refresh-token'),
      tokenExpiry: new Date(Date.now() + 3_600_000),
    });
    if (historyId) await updateHistoryId(googleId, historyId);
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
    hoisted.setListShouldThrow(false);
  });

  it('200s with the synced messages for an already-bootstrapped user', async () => {
    const googleId = await seedUser('500');
    await upsertMessages([
      {
        gmail_id: `msg-${randomUUID()}`,
        google_id: googleId,
        thread_id: 'thread-1',
        subject: 'Hello',
        from_address: 'a@example.com',
        to_address: 'b@example.com',
        snippet: 'hi',
        body_plain: 'hi',
        body_html: null,
        label_ids: ['INBOX'],
        is_read: true,
        is_starred: false,
        sent_at: new Date().toISOString(),
      },
    ]);
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({ headers: { authorization: `Bearer ${token}` } });
    await handler(req, res);

    expect(capture.statusCode).toBe(200);
    expect((capture.body as SuccessBody).data).toHaveLength(1);
    // Lazy bootstrap must not have run since history_id was already set.
    expect(hoisted.messagesListMock).not.toHaveBeenCalled();
  });

  it('UNAUTHENTICATED (401) with no Authorization header', async () => {
    const { req, res, capture } = createMockReqRes({});
    await handler(req, res);

    expect(capture.statusCode).toBe(401);
    expect((capture.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('VALIDATION_ERROR (400) when maxResults is not a positive integer', async () => {
    const googleId = await seedUser('500');
    const { token } = signSessionToken(googleId);
    const { req, res, capture } = createMockReqRes({
      headers: { authorization: `Bearer ${token}` },
      query: { maxResults: 'not-a-number' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('GMAIL_API_ERROR (502) when the lazy-bootstrap initial sync fails upstream', async () => {
    const googleId = await seedUser(null); // no history_id -> triggers runInitialSync
    hoisted.setListShouldThrow(true);
    const { token } = signSessionToken(googleId);

    const { req, res, capture } = createMockReqRes({ headers: { authorization: `Bearer ${token}` } });
    await handler(req, res);

    expect(capture.statusCode).toBe(502);
    expect((capture.body as ErrorBody).error.code).toBe('GMAIL_API_ERROR');
  });

  it('INTERNAL_ERROR (500) on an unexpected non-Gmail failure', async () => {
    const googleId = await seedUser('500');
    const { token } = signSessionToken(googleId);
    // Spies on our own db helper (not the Supabase SDK) to deterministically exercise
    // the catch-all path, which is otherwise not reliably triggerable black-box.
    vi.spyOn(usersDb, 'getUserHistoryId').mockRejectedValueOnce(new Error('simulated internal failure'));

    const { req, res, capture } = createMockReqRes({ headers: { authorization: `Bearer ${token}` } });
    await handler(req, res);

    expect(capture.statusCode).toBe(500);
    expect((capture.body as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });
});
