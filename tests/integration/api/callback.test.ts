import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { gmail_v1 } from 'googleapis';

function fullMessage(id: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: id,
    labelIds: ['INBOX'],
    snippet: 'hi',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Welcome' },
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'me@example.com' },
      ],
      body: { data: Buffer.from('hi', 'utf8').toString('base64url') },
    },
  };
}

const hoisted = vi.hoisted(() => {
  let nextTokens: Record<string, unknown> = {};
  let nextTokenInfo: { sub?: string; email?: string } | null = null;
  let getTokenShouldThrow = false;
  let messagesListShouldThrow = false;

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
      if (getTokenShouldThrow) throw new Error('simulated Google rejection of the code');
      return { tokens: nextTokens };
    }
    setCredentials(creds: Record<string, unknown>): void {
      this.credentials = creds;
    }
    async getTokenInfo(_accessToken: string) {
      return nextTokenInfo ?? {};
    }
    async refreshAccessToken() {
      return { credentials: {} };
    }
  }

  return {
    FakeOAuth2Client,
    watchMock: vi.fn(),
    messagesListMock: vi.fn(async () => {
      if (messagesListShouldThrow) throw new Error('simulated Gmail upstream failure');
      return { data: { messages: [{ id: 'msg-1' }], nextPageToken: null } };
    }),
    messagesGetMock: vi.fn(async () => ({ data: fullMessage('msg-1') })),
    getProfileMock: vi.fn(async () => ({ data: { historyId: '500' } })),
    setNextTokens: (t: Record<string, unknown>) => {
      nextTokens = t;
    },
    setNextTokenInfo: (p: { sub?: string; email?: string } | null) => {
      nextTokenInfo = p;
    },
    setGetTokenShouldThrow: (v: boolean) => {
      getTokenShouldThrow = v;
    },
    setMessagesListShouldThrow: (v: boolean) => {
      messagesListShouldThrow = v;
    },
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: hoisted.FakeOAuth2Client },
    gmail: () => ({
      users: {
        watch: hoisted.watchMock,
        messages: { list: hoisted.messagesListMock, get: hoisted.messagesGetMock },
        getProfile: hoisted.getProfileMock,
      },
    }),
  },
}));

import handler from '../../../api/v1/auth/google/callback';
import { createMockReqRes } from '../../helpers/http';
import { getServiceClient } from '../../../src/db';

interface ErrorBody {
  error: { code: string; message: string };
}
interface SuccessBody {
  data: { accessToken: string; user: { id: string; email: string } };
}

describe('GET /api/v1/auth/google/callback', () => {
  const createdGoogleIds: string[] = [];

  afterEach(async () => {
    const supabase = getServiceClient();
    for (const googleId of createdGoogleIds) {
      await supabase.from('messages').delete().eq('google_id', googleId);
      await supabase.from('users').delete().eq('google_id', googleId);
    }
    createdGoogleIds.length = 0;
    vi.clearAllMocks();
    hoisted.setGetTokenShouldThrow(false);
    hoisted.setNextTokenInfo(null);
    hoisted.setMessagesListShouldThrow(false);
  });

  it('200s and issues a session JWT on the happy path', async () => {
    const googleId = `test-${randomUUID()}`;
    const email = `${googleId}@example.com`;
    hoisted.setNextTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 3_600_000,
      id_token: 'fake-id-token',
    });
    hoisted.setNextTokenInfo({ sub: googleId, email });
    hoisted.watchMock.mockResolvedValue({ data: { historyId: '1', expiration: String(Date.now() + 604_800_000) } });

    const { req, res, capture } = createMockReqRes({
      query: { code: 'good-code', state: 'csrf-state' },
      cookies: { oauth_state: 'csrf-state' },
    });
    await handler(req, res);
    createdGoogleIds.push(googleId);

    expect(capture.statusCode).toBe(200);
    const body = capture.body as SuccessBody;
    expect(typeof body.data.accessToken).toBe('string');
    expect(body.data.user).toEqual({ id: googleId, email });

    // The post-login initial sync (unit 3's runInitialSync) should have populated
    // messages, not just persisted tokens/watch info.
    const supabase = getServiceClient();
    const { data: messageRow } = await supabase
      .from('messages')
      .select('gmail_id, google_id')
      .eq('gmail_id', 'msg-1')
      .eq('google_id', googleId)
      .maybeSingle();
    expect(messageRow).toMatchObject({ gmail_id: 'msg-1', google_id: googleId });
  });

  it('still 200s and signs the user in even when the post-login initial sync fails (best-effort)', async () => {
    const googleId = `test-${randomUUID()}`;
    const email = `${googleId}@example.com`;
    hoisted.setNextTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 3_600_000,
      id_token: 'fake-id-token',
    });
    hoisted.setNextTokenInfo({ sub: googleId, email });
    hoisted.watchMock.mockResolvedValue({ data: { historyId: '1', expiration: String(Date.now() + 604_800_000) } });
    hoisted.setMessagesListShouldThrow(true);

    const { req, res, capture } = createMockReqRes({
      query: { code: 'good-code', state: 'csrf-state' },
      cookies: { oauth_state: 'csrf-state' },
    });
    await handler(req, res);
    createdGoogleIds.push(googleId);

    expect(capture.statusCode).toBe(200);
    const body = capture.body as SuccessBody;
    expect(body.data.user).toEqual({ id: googleId, email });
  });

  it('VALIDATION_ERROR (400) when code and state are both missing', async () => {
    const { req, res, capture } = createMockReqRes({ query: {} });
    await handler(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('OAUTH_DENIED (401) when Google redirects with error=access_denied', async () => {
    const { req, res, capture } = createMockReqRes({ query: { error: 'access_denied' } });
    await handler(req, res);

    expect(capture.statusCode).toBe(401);
    expect((capture.body as ErrorBody).error.code).toBe('OAUTH_DENIED');
  });

  it('OAUTH_EXCHANGE_FAILED (502) when Google rejects the code', async () => {
    hoisted.setGetTokenShouldThrow(true);
    const { req, res, capture } = createMockReqRes({
      query: { code: 'bad-code', state: 'csrf-state' },
      cookies: { oauth_state: 'csrf-state' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(502);
    expect((capture.body as ErrorBody).error.code).toBe('OAUTH_EXCHANGE_FAILED');
  });

  it('INTERNAL_ERROR (500) on an unexpected failure (id_token missing sub/email)', async () => {
    hoisted.setNextTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() + 3_600_000,
      id_token: 'fake-id-token',
    });
    hoisted.setNextTokenInfo({}); // no sub/email -> identifyUser throws UPSTREAM_ERROR, not AUTH_ERROR
    const { req, res, capture } = createMockReqRes({
      query: { code: 'good-code', state: 'csrf-state' },
      cookies: { oauth_state: 'csrf-state' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(500);
    expect((capture.body as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });

  it('VALIDATION_ERROR (400) when state does not match the oauth_state cookie', async () => {
    const { req, res, capture } = createMockReqRes({
      query: { code: 'good-code', state: 'csrf-state' },
      cookies: { oauth_state: 'a-different-value' },
    });
    await handler(req, res);

    expect(capture.statusCode).toBe(400);
    expect((capture.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('METHOD_NOT_ALLOWED (405) on a non-GET request', async () => {
    const { req, res, capture } = createMockReqRes({ method: 'POST', query: {} });
    await handler(req, res);

    expect(capture.statusCode).toBe(405);
    expect((capture.body as ErrorBody).error.code).toBe('METHOD_NOT_ALLOWED');
  });
});
