import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { gmail_v1 } from 'googleapis';

const hoisted = vi.hoisted(() => {
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
    historyListMock: vi.fn(),
    messagesGetMock: vi.fn(),
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: hoisted.FakeOAuth2Client },
    gmail: () => ({
      users: {
        history: { list: hoisted.historyListMock },
        messages: { get: hoisted.messagesGetMock },
      },
    }),
  },
}));

const waitUntilCapture = vi.hoisted(() => ({ promise: null as Promise<unknown> | null }));
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => {
    waitUntilCapture.promise = p;
  },
}));

import handleGmailWebhook from '../../../src/webhook/gmail';
import { createMockReqRes } from '../../helpers/http';
import { getServiceClient } from '../../../src/db/client';
import { upsertUserTokens, updateHistoryId, getUserHistoryId } from '../../../src/db/users';
import { encrypt } from '../../../src/providers/gmail/encryption';

function pubSubBody(emailAddress: string, historyId: string): { message: { data: string } } {
  const payload = JSON.stringify({ emailAddress, historyId });
  return { message: { data: Buffer.from(payload, 'utf8').toString('base64') } };
}

function fullMessage(id: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: id,
    labelIds: ['INBOX'],
    snippet: 'delta message',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Delta message' },
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'me@example.com' },
      ],
      body: { data: Buffer.from('delta body', 'utf8').toString('base64url') },
    },
  };
}

describe('Gmail Pub/Sub webhook receiver', () => {
  const createdGoogleIds: string[] = [];

  async function seedUser(historyId: string): Promise<string> {
    const googleId = `test-${randomUUID()}`;
    await upsertUserTokens({
      googleId,
      email: `${googleId}@example.com`,
      accessTokenEncrypted: encrypt('fake-access-token'),
      refreshTokenEncrypted: encrypt('fake-refresh-token'),
      tokenExpiry: new Date(Date.now() + 3_600_000),
    });
    await updateHistoryId(googleId, historyId);
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
    waitUntilCapture.promise = null;
  });

  it('acknowledges with 200 before the history-delta work completes (acknowledge-first pattern)', async () => {
    const googleId = await seedUser('500');
    const email = `${googleId}@example.com`;

    let historyListResolved = false;
    hoisted.historyListMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            historyListResolved = true;
            resolve({ data: { history: [], nextPageToken: null } });
          }, 150);
        })
    );

    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      query: { token: process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN as string },
      body: pubSubBody(email, '501'),
    });

    await handleGmailWebhook(req, res);

    // The response must already be sent...
    expect(capture.statusCode).toBe(200);
    expect(capture.ended).toBe(true);
    // ...while the deferred work (passed to waitUntil, not awaited inline) has not
    // necessarily finished yet.
    expect(waitUntilCapture.promise).not.toBeNull();
    expect(historyListResolved).toBe(false);

    await waitUntilCapture.promise;
    expect(historyListResolved).toBe(true);
  });

  it('fetches the delta from history.list using the stored history_id, upserts new messages, and checkpoints to the notification historyId', async () => {
    const googleId = await seedUser('500');
    const email = `${googleId}@example.com`;
    const newMessageId = `msg-${randomUUID()}`;

    hoisted.historyListMock.mockResolvedValue({
      data: {
        history: [{ messagesAdded: [{ message: { id: newMessageId } }] }],
        nextPageToken: null,
      },
    });
    hoisted.messagesGetMock.mockResolvedValue({ data: fullMessage(newMessageId) });

    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      query: { token: process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN as string },
      // Notification historyId (999) is deliberately different from history.list's own
      // response, which doesn't even return one here, proving the checkpoint comes from
      // the notification, not from history.list.
      body: pubSubBody(email, '999'),
    });

    await handleGmailWebhook(req, res);
    expect(capture.statusCode).toBe(200);
    await waitUntilCapture.promise;

    expect(hoisted.historyListMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', startHistoryId: '500' })
    );

    const supabase = getServiceClient();
    const { data: messageRow } = await supabase
      .from('messages')
      .select('gmail_id, google_id, subject')
      .eq('gmail_id', newMessageId)
      .single();
    expect(messageRow).toMatchObject({ gmail_id: newMessageId, google_id: googleId, subject: 'Delta message' });

    const historyIdAfter = await getUserHistoryId(googleId);
    expect(historyIdAfter).toBe('999');
  });

  it('rejects requests with a missing/invalid Pub/Sub verification token before doing any work', async () => {
    const { req, res, capture } = createMockReqRes({
      method: 'POST',
      query: { token: 'wrong-token' },
      body: pubSubBody('nobody@example.com', '1'),
    });

    await handleGmailWebhook(req, res);

    expect(capture.statusCode).toBe(401);
    expect(hoisted.historyListMock).not.toHaveBeenCalled();
    expect(waitUntilCapture.promise).toBeNull();
  });
});
