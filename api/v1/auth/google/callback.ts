import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleOAuthCallback } from '../../../../src/providers/gmail/auth';
import { signSessionToken } from '../../../../src/middleware/auth';
import { sendError, sendSuccess } from '../../../../src/http/respond';
import { ProviderError, ProviderErrorCode } from '../../../../src/types/provider';

function queryParam(req: VercelRequest, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (queryParam(req, 'error')) {
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

  // NOTE: state is only checked for presence here, not verified against a previously
  // issued value — there is no "initiate OAuth" HTTP endpoint yet that stores one to
  // compare against, so this is not yet real CSRF protection.

  try {
    const { googleId, email } = await handleOAuthCallback(code);
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
