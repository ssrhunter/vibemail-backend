import { randomBytes } from 'crypto';
import { google, Auth } from 'googleapis';
import { encrypt, decrypt } from './encryption';
import { upsertUserTokens, updateUserTokens, getUser, updateWatchExpiry, updateHistoryId } from '../../db';
import { ProviderError, ProviderErrorCode, ProviderTokens } from '../../types/provider';

type OAuth2Client = Auth.OAuth2Client;

// Narrow Gmail scopes plus 'openid'/'email' so the callback can identify who signed in
// (Google only returns the id_token carrying sub/email when 'openid' is requested).
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

/** Thrown when a required env var (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI) is missing —
 *  distinct from ProviderError so route handlers can map it to a dedicated config-error
 *  response instead of a generic internal failure. */
export class ConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigError(`${name} is not set`);
  }
  return value;
}

function createOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    requireEnv('GOOGLE_REDIRECT_URI')
  );
}

function tokenExpiryOf(tokens: Auth.Credentials): Date {
  return tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000);
}

function toProviderTokens(tokens: Auth.Credentials): ProviderTokens {
  if (!tokens.access_token) {
    throw new ProviderError(ProviderErrorCode.AUTH_ERROR, 'Google did not return an access token');
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    expiresAt: tokenExpiryOf(tokens),
    scope: tokens.scope ?? undefined,
    tokenType: tokens.token_type ?? undefined,
  };
}

/** Persists whatever the 'tokens' event hands us. Google omits refresh_token on
 *  ordinary refreshes, so we must never overwrite the stored one with nothing. */
async function persistRefreshedTokens(googleId: string, tokens: Auth.Credentials): Promise<void> {
  if (!tokens.access_token) return;
  await updateUserTokens({
    googleId,
    accessTokenEncrypted: encrypt(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
    tokenExpiry: tokenExpiryOf(tokens),
  });
}

function attachTokenPersistenceListener(client: OAuth2Client, googleId: string): void {
  client.on('tokens', (tokens: Auth.Credentials) => {
    void persistRefreshedTokens(googleId, tokens);
  });
}

/** Step 1: initiate the OAuth flow — the consent screen URL the client redirects the user to. */
export function getAuthUrl(state: string): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export interface InitiateOAuthResult {
  url: string;
  state: string;
}

/** Generates a fresh anti-CSRF state value and the consent URL for it. The caller
 *  (api/v1/auth/google/index.ts) is responsible for persisting `state` (e.g. an
 *  httpOnly cookie) so the callback can verify the value Google sends back matches. */
export function initiateOAuth(): InitiateOAuthResult {
  const state = randomBytes(32).toString('base64url');
  return { url: getAuthUrl(state), state };
}

/** Low-level code->tokens exchange, no persistence. Matches EmailProvider.exchangeCodeForTokens. */
export async function exchangeCodeForTokens(code: string): Promise<ProviderTokens> {
  const client = createOAuth2Client();
  let tokens: Auth.Credentials;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.AUTH_ERROR, 'Failed to exchange authorization code for tokens', err);
  }
  if (!tokens.refresh_token) {
    throw new ProviderError(
      ProviderErrorCode.AUTH_ERROR,
      'Google did not return a refresh token (re-consent with prompt=consent is required)'
    );
  }
  return toProviderTokens(tokens);
}

/** Identifies the signed-in user via Google's token-introspection endpoint
 *  (oauth2Client.getTokenInfo) rather than a separate profile API call. Note: TokenInfo
 *  has no `name` field — it's a token-introspection response (aud/sub/email/scopes/
 *  expiry), not a profile endpoint, so no display name is available from this call. */
async function identifyUser(client: OAuth2Client, accessToken: string): Promise<{ googleId: string; email: string }> {
  let tokenInfo;
  try {
    tokenInfo = await client.getTokenInfo(accessToken);
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Failed to fetch Google token info', err);
  }
  if (!tokenInfo.sub || !tokenInfo.email) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Google token info did not include sub/email');
  }
  return { googleId: tokenInfo.sub, email: tokenInfo.email };
}

/** Calls Gmail's users.watch and persists the new watch_expiry/history_id. Reused by both
 *  the OAuth callback (initial registration) and the renewal cron job (src/cron). */
export async function registerWatch(client: OAuth2Client, googleId: string): Promise<void> {
  const gmail = google.gmail({ version: 'v1', auth: client });
  let res;
  try {
    res = await gmail.users.watch({
      userId: 'me',
      requestBody: { topicName: requireEnv('GOOGLE_PUBSUB_TOPIC') },
    });
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Failed to register Gmail watch', err);
  }
  const { historyId, expiration } = res.data;
  if (!historyId || !expiration) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Gmail watch response missing historyId/expiration');
  }
  await updateWatchExpiry(googleId, new Date(Number(expiration)));
  await updateHistoryId(googleId, historyId);
}

/** Step 2: handle the OAuth callback — exchange the code, identify the user, encrypt + persist
 *  tokens (upsert on google_id), wire up the auto-refresh listener, and register the Gmail watch. */
export async function handleOAuthCallback(code: string): Promise<{ googleId: string; email: string }> {
  const client = createOAuth2Client();
  let tokens: Auth.Credentials;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.AUTH_ERROR, 'Failed to exchange authorization code for tokens', err);
  }
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new ProviderError(
      ProviderErrorCode.AUTH_ERROR,
      'Incomplete token response from Google (missing access_token or refresh_token)'
    );
  }
  client.setCredentials(tokens);

  const { googleId, email } = await identifyUser(client, tokens.access_token);

  await upsertUserTokens({
    googleId,
    email,
    accessTokenEncrypted: encrypt(tokens.access_token),
    refreshTokenEncrypted: encrypt(tokens.refresh_token),
    tokenExpiry: tokenExpiryOf(tokens),
  });

  attachTokenPersistenceListener(client, googleId);
  await registerWatch(client, googleId);

  return { googleId, email };
}

/** Rebuilds an authenticated client for a known user from their stored, encrypted tokens.
 *  For use by later units (sync/send) that need to call the Gmail API as this user. */
export async function getAuthenticatedClient(googleId: string): Promise<OAuth2Client> {
  const stored = await getUser(googleId);
  if (!stored) {
    throw new ProviderError(ProviderErrorCode.NOT_FOUND, `No stored tokens for google_id ${googleId}`);
  }
  const client = createOAuth2Client();
  client.setCredentials({
    access_token: decrypt(stored.access_token_encrypted),
    refresh_token: decrypt(stored.refresh_token_encrypted),
    expiry_date: new Date(stored.token_expiry).getTime(),
  });
  attachTokenPersistenceListener(client, googleId);
  return client;
}

/** Explicit, on-demand refresh: loads the stored encrypted refresh token, decrypts it,
 *  exchanges it for a new access token, and persists the result before returning. */
export async function refreshStoredAccessToken(googleId: string): Promise<ProviderTokens> {
  const stored = await getUser(googleId);
  if (!stored) {
    throw new ProviderError(ProviderErrorCode.NOT_FOUND, `No stored tokens for google_id ${googleId}`);
  }
  const client = createOAuth2Client();
  const refreshToken = decrypt(stored.refresh_token_encrypted);
  client.setCredentials({ refresh_token: refreshToken });

  let tokens: Auth.Credentials;
  try {
    ({ credentials: tokens } = await client.refreshAccessToken());
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.INVALID_TOKEN, 'Failed to refresh access token', err);
  }
  if (!tokens.access_token) {
    throw new ProviderError(ProviderErrorCode.INVALID_TOKEN, 'Google did not return a new access token');
  }

  await updateUserTokens({
    googleId,
    accessTokenEncrypted: encrypt(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
    tokenExpiry: tokenExpiryOf(tokens),
  });

  return toProviderTokens({ ...tokens, refresh_token: tokens.refresh_token ?? refreshToken });
}
