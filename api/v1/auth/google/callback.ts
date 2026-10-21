import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleOAuthCallback } from '../../../../src/providers/gmail/auth';
import { signSessionToken } from '../../../../src/middleware/auth';
import { sendError, sendSuccess } from '../../../../src/http/respond';
import { OAUTH_STATE_COOKIE_NAME, clearOAuthStateCookie } from '../../../../src/http/cookies';
import { ProviderError, ProviderErrorCode } from '../../../../src/types/provider';
import { runInitialSync } from '../../../../src/sync';

function queryParam(req: VercelRequest, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on this endpoint`);
    return;
  }

  if (queryParam(req, 'error')) {
    res.setHeader('Set-Cookie', clearOAuthStateCookie());
    sendError(res, 401, 'OAUTH_DENIED', 'User declined consent on Google\'s screen');
    return;
  }

  const code = queryParam(req, 'code');
  const state = queryParam(req, 'state');
  if (!code || !state) {
    sendError(res, 400, 'VALIDATION_ERROR', 'code and state are both required query parameters', [
      ...(code ? [] : [{ field: 'code', issue: 'required' }]),
      ...(state ? [] : [{ field: 'state', issue: 'required' }]),
    ]);
    return;
  }

  // Verify state against the value initiateOAuth persisted in an httpOnly cookie —
  // real CSRF protection, not just a presence check.
  const expectedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];
  res.setHeader('Set-Cookie', clearOAuthStateCookie());
  if (!expectedState || expectedState !== state) {
    sendError(res, 400, 'VALIDATION_ERROR', 'state did not match the value issued when the OAuth flow started', [
      { field: 'state', issue: 'mismatch' },
    ]);
    return;
  }

  try {
    const { googleId, email } = await handleOAuthCallback(code);

    // Best-effort: populates messages with the 50 most recent immediately after login.
    // Never blocks or fails the callback — tokens are already persisted and the user
    // should still get signed in; GET /messages' lazy-bootstrap (runInitialSync when
    // history_id is null) backfills this later if it didn't complete here.
    try {
      await runInitialSync(googleId);
    } catch (syncErr) {
      console.error('Post-login initial sync failed (non-blocking):', syncErr);
    }

    const { token, expiresAt } = signSessionToken(googleId);
    sendSuccess(res, 200, {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      user: { id: googleId, email },
    });
  } catch (err) {
    if (err instanceof ProviderError && err.code === ProviderErrorCode.AUTH_ERROR) {
      sendError(res, 502, 'OAUTH_EXCHANGE_FAILED', err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected failure handling the OAuth callback');
  }
}
