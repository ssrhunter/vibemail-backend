import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withAuth } from '../../../src/middleware/auth';
import { sendError, sendSuccess } from '../../../src/http/respond';
import { markMessagesRead } from '../../../src/sync';

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

export default withAuth(async (req: VercelRequest, res: VercelResponse, googleId: string): Promise<void> => {
  const body = req.body as unknown;
  const messageIds =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).messageIds : undefined;

  if (!isNonEmptyStringArray(messageIds)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'messageIds must be a non-empty array of strings', [
      { field: 'messageIds', issue: 'required, non-empty array of strings' },
    ]);
    return;
  }

  try {
    const { succeeded, failed } = await markMessagesRead(googleId, messageIds);
    sendSuccess(res, 200, { succeeded, failed });
  } catch {
    sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected failure updating message read status');
  }
});
