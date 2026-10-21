export const OAUTH_STATE_COOKIE_NAME = 'oauth_state';

const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600;

function secureFlag(): string {
  // vercel dev sets VERCEL_ENV=development and serves over plain HTTP, where a Secure
  // cookie would never be sent back by the browser at all.
  return process.env.VERCEL_ENV === 'development' ? '' : '; Secure';
}

export function buildOAuthStateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE_NAME}=${state}; HttpOnly${secureFlag()}; SameSite=Lax; Path=/; Max-Age=${OAUTH_STATE_COOKIE_MAX_AGE_SECONDS}`;
}

export function clearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE_NAME}=; HttpOnly${secureFlag()}; SameSite=Lax; Path=/; Max-Age=0`;
}
