import type { VercelRequest, VercelResponse } from '@vercel/node';
import { initiateOAuth, ConfigError } from '../../../../src/providers/gmail/auth';
import { sendError } from '../../../../src/http/respond';
import { buildOAuthStateCookie } from '../../../../src/http/cookies';

/** Vercel entry point for GET /api/v1/auth/google — starts the OAuth flow by generating
 *  a consent URL and an anti-CSRF state, persisting that state in an httpOnly cookie,
 *  and redirecting the user to Google. callback.ts verifies the cookie on return. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on this endpoint`);
    return;
  }

  try {
    const { url, state } = initiateOAuth();
    res.setHeader('Set-Cookie', buildOAuthStateCookie(state));
    res.setHeader('Location', url);
    res.status(302).end();
  } catch (err) {
    if (err instanceof ConfigError) {
      sendError(res, 500, 'CONFIG_ERROR', err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected failure initiating the OAuth flow');
  }
}
