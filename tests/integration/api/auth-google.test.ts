import { describe, it, expect, vi, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  initiateOAuthMock: vi.fn(),
}));

vi.mock('../../../src/providers/gmail/auth', async () => {
  const actual = await vi.importActual<typeof import('../../../src/providers/gmail/auth')>(
    '../../../src/providers/gmail/auth'
  );
  return { ...actual, initiateOAuth: hoisted.initiateOAuthMock };
});

import handler from '../../../api/v1/auth/google/index';
import { createMockReqRes } from '../../helpers/http';
import { ConfigError } from '../../../src/providers/gmail/auth';

interface ErrorBody {
  error: { code: string; message: string };
}

describe('GET /api/v1/auth/google', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('302s to the generated url and sets an httpOnly oauth_state cookie', async () => {
    hoisted.initiateOAuthMock.mockReturnValue({ url: 'https://accounts.google.com/mock-consent-url', state: 'csrf-state' });
    const { req, res, capture } = createMockReqRes({});
    await handler(req, res);

    expect(capture.statusCode).toBe(302);
    expect(capture.headers.Location).toBe('https://accounts.google.com/mock-consent-url');
    const cookie = capture.headers['Set-Cookie'];
    expect(cookie).toContain('oauth_state=csrf-state');
    expect(cookie).toContain('HttpOnly');
  });

  it('CONFIG_ERROR (500) when initiateOAuth throws a configuration error', async () => {
    hoisted.initiateOAuthMock.mockImplementation(() => {
      throw new ConfigError('GOOGLE_CLIENT_ID is not set');
    });
    const { req, res, capture } = createMockReqRes({});
    await handler(req, res);

    expect(capture.statusCode).toBe(500);
    expect((capture.body as ErrorBody).error.code).toBe('CONFIG_ERROR');
  });

  it('INTERNAL_ERROR (500) on any other unexpected failure', async () => {
    hoisted.initiateOAuthMock.mockImplementation(() => {
      throw new Error('something else entirely');
    });
    const { req, res, capture } = createMockReqRes({});
    await handler(req, res);

    expect(capture.statusCode).toBe(500);
    expect((capture.body as ErrorBody).error.code).toBe('INTERNAL_ERROR');
  });

  it('METHOD_NOT_ALLOWED (405) on a non-GET request', async () => {
    const { req, res, capture } = createMockReqRes({ method: 'POST' });
    await handler(req, res);

    expect(capture.statusCode).toBe(405);
    expect((capture.body as ErrorBody).error.code).toBe('METHOD_NOT_ALLOWED');
  });
});
