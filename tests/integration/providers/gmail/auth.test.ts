import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

// googleapis is mocked (Gmail/OAuth calls); Supabase is the real client (no mock) per
// the instruction to run these against a live instance.
const hoisted = vi.hoisted(() => {
  let nextTokens: Record<string, unknown> = {};
  let nextIdTokenPayload: { sub?: string; email?: string } = {};
  const instances: InstanceType<typeof FakeOAuth2Client>[] = [];
  const watchMock = vi.fn();

  // Hand-rolled instead of `extends EventEmitter`: referencing an imported value from
  // inside vi.hoisted() hits a TDZ error, since Vitest hoists vi.mock/vi.hoisted calls
  // above even unrelated import initialization.
  class FakeOAuth2Client {
    private tokenListeners: Array<(tokens: Record<string, unknown>) => void> = [];
    public credentials: Record<string, unknown> = {};
    constructor() {
      instances.push(this);
    }
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
      return 'https://accounts.google.com/mock-auth-url';
    }
    async getToken(_code: string) {
      return { tokens: nextTokens };
    }
    setCredentials(creds: Record<string, unknown>): void {
      this.credentials = creds;
    }
    async verifyIdToken() {
      return { getPayload: () => nextIdTokenPayload };
    }
    async refreshAccessToken() {
      return { credentials: nextTokens };
    }
  }

  return {
    FakeOAuth2Client,
    instances,
    watchMock,
    setNextTokens: (t: Record<string, unknown>) => {
      nextTokens = t;
    },
    setNextIdTokenPayload: (p: { sub?: string; email?: string }) => {
      nextIdTokenPayload = p;
    },
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: hoisted.FakeOAuth2Client },
    gmail: () => ({ users: { watch: hoisted.watchMock } }),
  },
}));

import { handleOAuthCallback } from '../../../../src/providers/gmail/auth';
import { decrypt } from '../../../../src/providers/gmail/encryption';
import { getServiceClient } from '../../../../src/db';

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitUntil: condition was not met before timeout');
}

describe('OAuth callback: token encryption, persistence, and the refresh listener', () => {
  const createdGoogleIds: string[] = [];

  afterEach(async () => {
    const supabase = getServiceClient();
    for (const googleId of createdGoogleIds) {
      await supabase.from('users').delete().eq('google_id', googleId);
    }
    createdGoogleIds.length = 0;
    vi.clearAllMocks();
  });

  it('encrypts the access/refresh tokens before persisting them (never stored as plaintext)', async () => {
    const googleId = `test-${randomUUID()}`;
    const email = `${googleId}@example.com`;
    hoisted.setNextTokens({
      access_token: 'plaintext-access-token',
      refresh_token: 'plaintext-refresh-token',
      expiry_date: Date.now() + 3600_000,
      id_token: 'fake-id-token',
    });
    hoisted.setNextIdTokenPayload({ sub: googleId, email });
    hoisted.watchMock.mockResolvedValue({ data: { historyId: '1000', expiration: String(Date.now() + 604_800_000) } });

    const result = await handleOAuthCallback('fake-auth-code');
    createdGoogleIds.push(result.googleId);

    expect(result).toEqual({ googleId, email });

    const supabase = getServiceClient();
    const { data: row, error } = await supabase
      .from('users')
      .select('access_token_encrypted, refresh_token_encrypted')
      .eq('google_id', googleId)
      .single();

    expect(error).toBeNull();
    expect(row).not.toBeNull();
    expect(row?.access_token_encrypted).not.toBe('plaintext-access-token');
    expect(row?.refresh_token_encrypted).not.toBe('plaintext-refresh-token');
    expect(decrypt(row?.access_token_encrypted ?? '')).toBe('plaintext-access-token');
    expect(decrypt(row?.refresh_token_encrypted ?? '')).toBe('plaintext-refresh-token');
  });

  it('fires the token persistence listener on an auto-refresh and preserves the existing refresh token when none is reissued', async () => {
    const googleId = `test-${randomUUID()}`;
    const email = `${googleId}@example.com`;
    hoisted.setNextTokens({
      access_token: 'initial-access-token',
      refresh_token: 'initial-refresh-token',
      expiry_date: Date.now() + 3600_000,
      id_token: 'fake-id-token',
    });
    hoisted.setNextIdTokenPayload({ sub: googleId, email });
    hoisted.watchMock.mockResolvedValue({ data: { historyId: '1000', expiration: String(Date.now() + 604_800_000) } });

    await handleOAuthCallback('fake-auth-code');
    createdGoogleIds.push(googleId);

    const client = hoisted.instances[hoisted.instances.length - 1];
    // Simulate googleapis auto-refreshing: a new access_token, no refresh_token (the
    // normal case — Google only resends it on first consent).
    client.emit('tokens', { access_token: 'refreshed-access-token', expiry_date: Date.now() + 1_800_000 });

    const supabase = getServiceClient();
    await waitUntil(async () => {
      const { data } = await supabase.from('users').select('access_token_encrypted').eq('google_id', googleId).single();
      return Boolean(data?.access_token_encrypted && decrypt(data.access_token_encrypted) === 'refreshed-access-token');
    });

    const { data: row } = await supabase
      .from('users')
      .select('access_token_encrypted, refresh_token_encrypted')
      .eq('google_id', googleId)
      .single();

    expect(row).not.toBeNull();
    expect(decrypt(row?.access_token_encrypted ?? '')).toBe('refreshed-access-token');
    // The listener must not have overwritten the refresh token with nothing.
    expect(decrypt(row?.refresh_token_encrypted ?? '')).toBe('initial-refresh-token');
  });
});
