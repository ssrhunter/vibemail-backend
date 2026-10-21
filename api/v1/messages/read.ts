import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withAuth } from '../../../src/middleware/auth';
import { sendError, sendSuccess } from '../../../src/http/respond';
import { setMessagesReadStatus } from '../../../src/sync';

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

export default withAuth(async (req: VercelRequest, res: VercelResponse, googleId: string): Promise<void> => {
  const body = req.body as unknown;
  const bodyObj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const messageIds = bodyObj.messageIds;

  if (!isNonEmptyStringArray(messageIds)) {
    sendError(res, 400, 'VALIDATION_ERROR', 'messageIds must be a non-empty array of strings', [
      { field: 'messageIds', issue: 'required, non-empty array of strings' },
    ]);
    return;
  }

  // Defaults to true (mark read) so existing callers that only ever sent messageIds
  // keep their current behavior unchanged.
  let isRead = true;
  if (bodyObj.isRead !== undefined) {
    if (typeof bodyObj.isRead !== 'boolean') {
      sendError(res, 400, 'VALIDATION_ERROR', 'isRead must be a boolean', [{ field: 'isRead', issue: 'must be a boolean' }]);
      return;
    }
    isRead = bodyObj.isRead;
  }

  try {
    const { succeeded, failed } = await setMessagesReadStatus(googleId, messageIds, isRead);
    sendSuccess(res, 200, { succeeded, failed });
  } catch {
    sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected failure updating message read status');
  }
});
