import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cachedClient = createClient(url, serviceRoleKey);
  return cachedClient;
}

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

export async function updateUserTokens(input: UpdateUserTokensInput): Promise<void> {
  const supabase = getServiceClient();
  const patch: Record<string, string> = {
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

export interface StoredUserRecord {
  googleId: string;
  email: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiry: string;
}

export async function getUserByGoogleId(googleId: string): Promise<StoredUserRecord | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('users')
    .select('google_id, email, access_token_encrypted, refresh_token_encrypted, token_expiry')
    .eq('google_id', googleId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load user by google_id: ${error.message}`);
  }
  if (!data) return null;
  return {
    googleId: data.google_id,
    email: data.email,
    accessTokenEncrypted: data.access_token_encrypted,
    refreshTokenEncrypted: data.refresh_token_encrypted,
    tokenExpiry: data.token_expiry,
  };
}

export interface UpdateWatchInfoInput {
  googleId: string;
  watchExpiry: Date;
  historyId: string;
}

export async function updateWatchInfo(input: UpdateWatchInfoInput): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase
    .from('users')
    .update({
      watch_expiry: input.watchExpiry.toISOString(),
      history_id: input.historyId,
      updated_at: new Date().toISOString(),
    })
    .eq('google_id', input.googleId);
  if (error) {
    throw new Error(`Failed to update watch info: ${error.message}`);
  }
}
