import { describe, it, expect } from 'vitest';
import type { gmail_v1 } from 'googleapis';
import { normalizeMessage } from '../../../src/sync';

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function header(name: string, value: string): gmail_v1.Schema$MessagePartHeader {
  return { name, value };
}

describe('normalizeMessage', () => {
  it('extracts headers by name case-insensitively', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: [],
      snippet: 'hi',
      payload: {
        mimeType: 'text/plain',
        headers: [
          header('subject', 'Hello World'), // lowercase
          header('FROM', 'sender@example.com'), // uppercase
          header('To', 'recipient@example.com, other@example.com'),
          header('Date', 'Tue, 13 Oct 2026 10:00:00 -0700'),
        ],
        body: { data: b64url('plain body') },
      },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.subject).toBe('Hello World');
    expect(row.from_address).toBe('sender@example.com');
    expect(row.to_address).toBe('recipient@example.com, other@example.com');
  });

  it('maps from/to headers specifically to from_address/to_address columns', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-2',
      threadId: 'thread-2',
      labelIds: [],
      payload: {
        mimeType: 'text/plain',
        headers: [header('From', 'a@x.com'), header('To', 'b@y.com')],
        body: { data: b64url('body') },
      },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.from_address).toBe('a@x.com');
    expect(row.to_address).toBe('b@y.com');
  });

  it('returns null for headers that are absent entirely', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-3',
      threadId: 'thread-3',
      labelIds: [],
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('body') } },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.subject).toBeNull();
    expect(row.from_address).toBeNull();
    expect(row.to_address).toBeNull();
    expect(row.sent_at).toBeNull();
  });

  it('base64url-decodes a single-part text/plain message via the payload.body.data fallback', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-4',
      threadId: 'thread-4',
      labelIds: [],
      payload: {
        mimeType: 'text/plain',
        headers: [],
        body: { data: b64url('hello from single part') },
      },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.body_plain).toBe('hello from single part');
    expect(row.body_html).toBeNull();
  });

  it('base64url-decodes a single-part text/html message via the payload.body.data fallback', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-5',
      threadId: 'thread-5',
      labelIds: [],
      payload: {
        mimeType: 'text/html',
        headers: [],
        body: { data: b64url('<p>hello html</p>') },
      },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.body_html).toBe('<p>hello html</p>');
    expect(row.body_plain).toBeNull();
  });

  it('decodes both text/plain and text/html from a multipart/alternative parts array', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-6',
      threadId: 'thread-6',
      labelIds: [],
      payload: {
        mimeType: 'multipart/alternative',
        headers: [],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('plain version') } },
          { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
        ],
      },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.body_plain).toBe('plain version');
    expect(row.body_html).toBe('<p>html version</p>');
  });

  it('recurses into nested multipart/mixed > multipart/alternative and skips attachment parts', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-7',
      threadId: 'thread-7',
      labelIds: [],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64url('nested plain') } },
              { mimeType: 'text/html', body: { data: b64url('<p>nested html</p>') } },
            ],
          },
          {
            mimeType: 'application/pdf',
            filename: 'report.pdf',
            body: { data: b64url('not-real-pdf-bytes'), attachmentId: 'att-1' },
          },
        ],
      },
    };

    const row = normalizeMessage(raw, 'google-123');

    expect(row.body_plain).toBe('nested plain');
    expect(row.body_html).toBe('<p>nested html</p>');
  });

  it('derives is_read=true when UNREAD is absent from labelIds', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-8',
      threadId: 'thread-8',
      labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x') } },
    };

    expect(normalizeMessage(raw, 'google-123').is_read).toBe(true);
  });

  it('derives is_read=false when UNREAD is present in labelIds', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-9',
      threadId: 'thread-9',
      labelIds: ['INBOX', 'UNREAD'],
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x') } },
    };

    expect(normalizeMessage(raw, 'google-123').is_read).toBe(false);
  });

  it('derives is_starred=true only when STARRED is present in labelIds', () => {
    const starred: gmail_v1.Schema$Message = {
      id: 'msg-10',
      threadId: 'thread-10',
      labelIds: ['INBOX', 'STARRED'],
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x') } },
    };
    const notStarred: gmail_v1.Schema$Message = {
      id: 'msg-11',
      threadId: 'thread-11',
      labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x') } },
    };

    expect(normalizeMessage(starred, 'google-123').is_starred).toBe(true);
    expect(normalizeMessage(notStarred, 'google-123').is_starred).toBe(false);
  });

  it('treats a missing labelIds array as empty for both derived booleans', () => {
    const raw: gmail_v1.Schema$Message = {
      id: 'msg-12',
      threadId: 'thread-12',
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url('x') } },
    };

    const row = normalizeMessage(raw, 'google-123');
    expect(row.is_read).toBe(true);
    expect(row.is_starred).toBe(false);
    expect(row.label_ids).toEqual([]);
  });

  it('throws a ProviderError when the raw message is missing id/threadId', () => {
    const raw: gmail_v1.Schema$Message = { payload: { headers: [] } };
    expect(() => normalizeMessage(raw, 'google-123')).toThrow();
  });
});
