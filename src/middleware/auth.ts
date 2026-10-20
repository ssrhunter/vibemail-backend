import jwt from 'jsonwebtoken';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendError } from '../http/respond';

const SESSION_TOKEN_TTL = '30d';

interface SessionTokenPayload {
  googleId: string;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export interface IssuedSessionToken {
  token: string;
  expiresAt: Date;
}

/** Issues our own session JWT (not a Google token) carrying just the googleId, for the
 *  client to send back as `Authorization: Bearer <token>` on every other endpoint. */
export function signSessionToken(googleId: string): IssuedSessionToken {
  const payload: SessionTokenPayload = { googleId };
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: SESSION_TOKEN_TTL });
  const decoded = jwt.decode(token);
  const exp = decoded && typeof decoded === 'object' ? (decoded as { exp?: unknown }).exp : undefined;
  const expiresAt = typeof exp === 'number' ? new Date(exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

function extractBearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export type AuthenticatedHandler = (req: VercelRequest, res: VercelResponse, googleId: string) => Promise<void>;

/** Wraps a route handler so it only runs once a valid session JWT is present, extracting
 *  googleId from it. Vercel functions have no middleware chain, so this is a plain HOF. */
export function withAuth(handler: AuthenticatedHandler) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, 401, 'UNAUTHENTICATED', 'Missing bearer token');
      return;
    }

    let payload: SessionTokenPayload;
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      if (typeof decoded !== 'object' || decoded === null || typeof (decoded as { googleId?: unknown }).googleId !== 'string') {
        throw new Error('Malformed session token payload');
      }
      payload = decoded as SessionTokenPayload;
    } catch {
      sendError(res, 401, 'UNAUTHENTICATED', 'Invalid or expired bearer token');
      return;
    }

    await handler(req, res, payload.googleId);
  };
}
