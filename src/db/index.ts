import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables, TablesInsert } from '../types/database';

export type UserRow = Tables<'users'>;
export type MessageRow = Tables<'messages'>;
export type MessageInsert = TablesInsert<'messages'>;

let cachedClient: SupabaseClient<Database> | null = null;

/** Service-role Supabase client — used for every write in this module (and every read
 *  that needs to bypass RLS), per the service-role-key requirement. */
export function getServiceClient(): SupabaseClient<Database> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cachedClient = createClient<Database>(url, serviceRoleKey);
  return cachedClient;
}

export class InvalidCursorError extends Error {}

// ---------------------------------------------------------------------------
// Users. The schema's identifier/PK is `google_id` — there is no separate
// generic "userId" column (no Supabase Auth session backs this table).
// ---------------------------------------------------------------------------

export interface UpsertUserTokensInput {
  googleId: string;
  email: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiry: Date;
}

export async function upsertUserTokens(input: UpsertUserTokensInput): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.from('users').upsert(
    {
      google_id: input.googleId,
      email: input.email,
      access_token_encrypted: input.accessTokenEncrypted,
      refresh_token_encrypted: input.refreshTokenEncrypted,
      token_expiry: input.tokenExpiry.toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'google_id' }
  );
  if (error) {
    throw new Error(`Failed to upsert user tokens: ${error.message}`);
  }
}

export interface UpdateUserTokensInput {
  googleId: string;
  accessTokenEncrypted: string;
  // Omit to preserve the existing stored refresh token (Google only resends it on first consent).
  refreshTokenEncrypted?: string;
  tokenExpiry: Date;
}

/** Called by the token persistence listener whenever the OAuth2 client auto-refreshes. */
export async function updateUserTokens(input: UpdateUserTokensInput): Promise<void> {
  const supabase = getServiceClient();
  const patch: Database['public']['Tables']['users']['Update'] = {
    access_token_encrypted: input.accessTokenEncrypted,
    token_expiry: input.tokenExpiry.toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (input.refreshTokenEncrypted) {
    patch.refresh_token_encrypted = input.refreshTokenEncrypted;
  }
  const { error } = await supabase.from('users').update(patch).eq('google_id', input.googleId);
  if (error) {
    throw new Error(`Failed to update user tokens: ${error.message}`);
  }
}

/** Fetches a user row by its id. In this schema the id is `google_id` — there is no
 *  separate generic userId to look up by. */
export async function getUser(userId: string): Promise<UserRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('users').select('*').eq('google_id', userId).maybeSingle();
  if (error) {
    throw new Error(`Failed to load user: ${error.message}`);
  }
  return data;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (error) {
    throw new Error(`Failed to load user by email: ${error.message}`);
  }
  return data;
}

/** Writes the new historyId after each sync (initial sync and each webhook delta). */
export async function updateHistoryId(googleId: string, historyId: string): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('users')
    .update({ history_id: historyId, updated_at: new Date().toISOString() })
    .eq('google_id', googleId);
  if (error) {
    throw new Error(`Failed to update history_id: ${error.message}`);
  }
}

/** Writes the new watch expiry after a watch registration/renewal. Gmail's users.watch
 *  response has no resource-id field (only historyId/expiration) — unlike Drive/Calendar's
 *  channel-based watch, there is nothing else to persist here. */
export async function updateWatchExpiry(googleId: string, watchExpiry: Date): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('users')
    .update({ watch_expiry: watchExpiry.toISOString(), updated_at: new Date().toISOString() })
    .eq('google_id', googleId);
  if (error) {
    throw new Error(`Failed to update watch_expiry: ${error.message}`);
  }
}

export interface UserWithExpiringWatch {
  googleId: string;
}

/** Users whose watch_expiry is already past, or due within `withinHours`. Excludes users
 *  with no watch registered at all (watch_expiry null). */
export async function getUsersWithExpiringWatch(withinHours: number): Promise<UserWithExpiringWatch[]> {
  const supabase = getServiceClient();
  const threshold = new Date(Date.now() + withinHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('users')
    .select('google_id')
    .not('watch_expiry', 'is', null)
    .lte('watch_expiry', threshold);
  if (error) {
    throw new Error(`Failed to load users with expiring watch: ${error.message}`);
  }
  return (data ?? []).map((row) => ({ googleId: row.google_id }));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function upsertMessages(rows: MessageInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const supabase = getServiceClient();
  const { error } = await supabase.from('messages').upsert(rows, { onConflict: 'gmail_id' });
  if (error) {
    throw new Error(`Failed to upsert messages: ${error.message}`);
  }
}

/** Upserts a single message (gmail_id as the conflict target). Normalization — including
 *  mapping the From/To headers to from_address/to_address — happens upstream in
 *  src/sync's normalizeMessage; this just writes the already-shaped row. */
export async function upsertMessage(row: MessageInsert): Promise<void> {
  await upsertMessages([row]);
}

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
  const rows = data ?? [];
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
  return data ? data.label_ids : null;
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
