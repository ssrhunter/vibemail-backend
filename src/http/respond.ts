import { randomUUID } from 'crypto';
import type { VercelResponse } from '@vercel/node';

export function sendSuccess(res: VercelResponse, status: number, data: unknown, meta: Record<string, unknown> = {}): void {
  res.status(status).json({ data, meta: { requestId: randomUUID(), ...meta } });
}

export function sendError(res: VercelResponse, status: number, code: string, message: string, details: unknown[] = []): void {
  res.status(status).json({ error: { code, message, details }, meta: { requestId: randomUUID() } });
}
