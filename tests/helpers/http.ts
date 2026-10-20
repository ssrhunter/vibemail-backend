import type { VercelRequest, VercelResponse } from '@vercel/node';

export interface MockResponseCapture {
  statusCode: number | null;
  body: unknown;
  ended: boolean;
}

export interface MockRequestInit {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Minimal req/res fakes for calling a Vercel function handler directly in tests,
 *  capturing whatever status/body it sent, without spinning up a real HTTP server. */
export function createMockReqRes(init: MockRequestInit = {}): {
  req: VercelRequest;
  res: VercelResponse;
  capture: MockResponseCapture;
} {
  const capture: MockResponseCapture = { statusCode: null, body: undefined, ended: false };

  const req = {
    method: init.method ?? 'GET',
    query: init.query ?? {},
    headers: init.headers ?? {},
    body: init.body,
  } as unknown as VercelRequest;

  const res = {
    status(code: number) {
      capture.statusCode = code;
      return res;
    },
    json(body: unknown) {
      capture.body = body;
      capture.ended = true;
      return res;
    },
    end(body?: unknown) {
      capture.ended = true;
      if (body !== undefined) capture.body = body;
      return res;
    },
  } as unknown as VercelResponse;

  return { req, res, capture };
}
