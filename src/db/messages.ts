import { getServiceClient } from './client';

export interface MessageRow {
  gmail_id: string;
  google_id: string;
  thread_id: string;
  subject: string | null;
  from_address: string | null;
  to_address: string | null;
  snippet: string | null;
  body_plain: string | null;
  body_html: string | null;
  label_ids: string[];
  is_read: boolean;
  is_starred: boolean;
  sent_at: string | null;
}

export async function upsertMessages(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const supabase = getServiceClient();
  const { error } = await supabase.from('messages').upsert(rows, { onConflict: 'gmail_id' });
  if (error) {
    throw new Error(`Failed to upsert messages: ${error.message}`);
  }
}

export class InvalidCursorError extends Error {}

interface DecodedCursor {
  sentAt: string;
}

function encodeCursor(sentAt: string): string {
  const payload: DecodedCursor = { sentAt };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('Malformed pageToken');
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { sentAt?: unknown }).sentAt !== 'string') {
    throw new InvalidCursorError('Malformed pageToken');
  }
  return parsed as DecodedCursor;
}

export interface ListMessagesPageInput {
  googleId: string;
  limit: number;
  cursor?: string;
  label?: string;
  q?: string;
}

export interface ListMessagesPageResult {
  rows: MessageRow[];
  nextCursor?: string;
}

/** Reads a page of already-synced messages straight from Postgres (ordered newest first
 *  by sent_at) — no live Gmail call. `label` and `q` are best-effort filters over the
 *  synced data (array-contains and a plain ILIKE on subject/snippet), not Gmail's own
 *  search syntax, since the provider abstraction (unit 1) deliberately has no passthrough
 *  query parameter. */
export async function listMessagesPage(input: ListMessagesPageInput): Promise<ListMessagesPageResult> {
  const supabase = getServiceClient();
  let query = supabase
    .from('messages')
    .select('*')
    .eq('google_id', input.googleId)
    .order('sent_at', { ascending: false })
    .limit(input.limit);

  if (input.cursor) {
    const { sentAt } = decodeCursor(input.cursor);
    query = query.lt('sent_at', sentAt);
  }
  if (input.label) {
    query = query.contains('label_ids', [input.label]);
  }
  if (input.q) {
    const pattern = `%${input.q}%`;
    query = query.or(`subject.ilike.${pattern},snippet.ilike.${pattern}`);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to list messages: ${error.message}`);
  }
  const rows = (data ?? []) as MessageRow[];
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === input.limit && last?.sent_at ? encodeCursor(last.sent_at) : undefined;
  return { rows, nextCursor };
}

export async function getMessageLabelIds(gmailId: string, googleId: string): Promise<string[] | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('messages')
    .select('label_ids')
    .eq('gmail_id', gmailId)
    .eq('google_id', googleId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load message label_ids: ${error.message}`);
  }
  return data ? (data.label_ids as string[]) : null;
}

export async function updateMessageReadStatus(
  gmailId: string,
  googleId: string,
  isRead: boolean,
  labelIds: string[]
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('messages')
    .update({ is_read: isRead, label_ids: labelIds })
    .eq('gmail_id', gmailId)
    .eq('google_id', googleId);
  if (error) {
    throw new Error(`Failed to update message read status: ${error.message}`);
  }
}
