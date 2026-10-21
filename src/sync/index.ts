import { google, gmail_v1 } from 'googleapis';
import { getAuthenticatedClient } from '../providers/gmail/auth';
import { updateHistoryId, upsertMessages, MessageInsert, getMessageLabelIds, updateMessageReadStatus } from '../db';
import { ProviderError, ProviderErrorCode } from '../types/provider';

const INITIAL_SYNC_LIMIT = 50;

function getHeader(headers: gmail_v1.Schema$MessagePart['headers'], name: string): string | null {
  const match = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

interface Bodies {
  bodyPlain: string | null;
  bodyHtml: string | null;
}

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): Bodies {
  const result: Bodies = { bodyPlain: null, bodyHtml: null };
  if (!payload) return result;

  function visit(part: gmail_v1.Schema$MessagePart): void {
    if (part.parts && part.parts.length > 0) {
      for (const child of part.parts) visit(child);
      return;
    }
    // A leaf part with a filename is an attachment, not a text body.
    if (part.filename) return;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      result.bodyPlain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      result.bodyHtml = decodeBase64Url(part.body.data);
    }
  }

  if (payload.parts && payload.parts.length > 0) {
    visit(payload);
  } else if (payload.body?.data) {
    // Single-part message: no parts array, body lives directly on payload.body.data.
    if (payload.mimeType === 'text/html') {
      result.bodyHtml = decodeBase64Url(payload.body.data);
    } else {
      result.bodyPlain = decodeBase64Url(payload.body.data);
    }
  }
  return result;
}

function parseSentAt(dateHeader: string | null): string | null {
  if (!dateHeader) return null;
  const parsed = new Date(dateHeader);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeMessage(raw: gmail_v1.Schema$Message, googleId: string): MessageInsert {
  if (!raw.id || !raw.threadId) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Gmail message missing id/threadId');
  }
  const headers = raw.payload?.headers;
  const labelIds = raw.labelIds ?? [];
  const { bodyPlain, bodyHtml } = extractBodies(raw.payload);

  return {
    gmail_id: raw.id,
    google_id: googleId,
    thread_id: raw.threadId,
    subject: getHeader(headers, 'Subject'),
    from_address: getHeader(headers, 'From'),
    to_address: getHeader(headers, 'To'),
    snippet: raw.snippet ?? null,
    body_plain: bodyPlain,
    body_html: bodyHtml,
    label_ids: labelIds,
    is_read: !labelIds.includes('UNREAD'),
    is_starred: labelIds.includes('STARRED'),
    sent_at: parseSentAt(getHeader(headers, 'Date')),
  };
}

async function collectInboxMessageIds(gmail: gmail_v1.Gmail, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    let page;
    try {
      page = await gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        pageToken,
      });
    } catch (err) {
      throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Failed to list Gmail messages', err);
    }
    for (const message of page.data.messages ?? []) {
      if (message.id) ids.push(message.id);
      if (ids.length >= limit) return ids.slice(0, limit);
    }
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

export async function fetchFullMessage(gmail: gmail_v1.Gmail, id: string): Promise<gmail_v1.Schema$Message> {
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    return res.data;
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, `Failed to get Gmail message ${id}`, err);
  }
}

export interface InitialSyncResult {
  syncedCount: number;
  historyId: string;
}

/** Fetches up to the first 50 INBOX messages for `googleId`, normalizes and upserts them,
 *  and records the mailbox's current historyId as the checkpoint for incremental sync. */
export async function runInitialSync(googleId: string): Promise<InitialSyncResult> {
  const client = await getAuthenticatedClient(googleId);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const ids = await collectInboxMessageIds(gmail, INITIAL_SYNC_LIMIT);

  const rows: MessageInsert[] = [];
  for (const id of ids) {
    const raw = await fetchFullMessage(gmail, id);
    rows.push(normalizeMessage(raw, googleId));
  }
  await upsertMessages(rows);

  let historyId: string;
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    if (!profile.data.historyId) {
      throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Gmail profile response missing historyId');
    }
    historyId = profile.data.historyId;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Failed to fetch Gmail profile for historyId', err);
  }
  await updateHistoryId(googleId, historyId);

  return { syncedCount: rows.length, historyId };
}

export interface MarkMessagesReadResult {
  succeeded: string[];
  failed: { id: string; code: string }[];
}

/** Removes the UNREAD label via Gmail for each id, then updates the stored row's
 *  is_read/label_ids to match. Per-id failures are collected rather than thrown, so one
 *  bad id in a batch doesn't fail the others. */
export async function markMessagesRead(googleId: string, gmailIds: string[]): Promise<MarkMessagesReadResult> {
  const client = await getAuthenticatedClient(googleId);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const succeeded: string[] = [];
  const failed: { id: string; code: string }[] = [];

  for (const id of gmailIds) {
    try {
      await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } });
      const currentLabelIds = (await getMessageLabelIds(id, googleId)) ?? [];
      const nextLabelIds = currentLabelIds.filter((label) => label !== 'UNREAD');
      await updateMessageReadStatus(id, googleId, true, nextLabelIds);
      succeeded.push(id);
    } catch {
      failed.push({ id, code: 'GMAIL_API_ERROR' });
    }
  }

  return { succeeded, failed };
}
