import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withAuth } from '../../../src/middleware/auth';
import { sendError, sendSuccess } from '../../../src/http/respond';
import { toApiMessage } from '../../../src/http/mappers';
import { getUser, listMessagesPage, InvalidCursorError } from '../../../src/db';
import { runInitialSync } from '../../../src/sync';
import { ProviderError, ProviderErrorCode } from '../../../src/types/provider';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function queryParam(req: VercelRequest, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

export default withAuth(async (req: VercelRequest, res: VercelResponse, googleId: string): Promise<void> => {
  const pageToken = queryParam(req, 'pageToken');
  const label = queryParam(req, 'label');
  const q = queryParam(req, 'q');

  let limit = DEFAULT_PAGE_SIZE;
  const maxResultsRaw = queryParam(req, 'maxResults');
  if (maxResultsRaw !== undefined) {
    const parsed = Number(maxResultsRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      sendError(res, 400, 'VALIDATION_ERROR', 'maxResults must be a positive integer', [
        { field: 'maxResults', issue: 'must be a positive integer' },
      ]);
      return;
    }
    limit = Math.min(parsed, MAX_PAGE_SIZE);
  }

  try {
    // Lazy bootstrap: a user with no sync checkpoint yet has never been synced at all —
    // run the one-time initial sync before reading. Once history_id exists, unit 4's
    // webhook is responsible for keeping Postgres fresh, so this just reads the DB.
    const user = await getUser(googleId);
    if (!user?.history_id) {
      await runInitialSync(googleId);
    }

    const { rows, nextCursor } = await listMessagesPage({ googleId, limit, cursor: pageToken, label, q });
    sendSuccess(res, 200, rows.map(toApiMessage), { nextPageToken: nextCursor });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      sendError(res, 400, 'VALIDATION_ERROR', 'pageToken is malformed', [{ field: 'pageToken', issue: 'malformed' }]);
      return;
    }
    if (err instanceof ProviderError && err.code === ProviderErrorCode.UPSTREAM_ERROR) {
      sendError(res, 502, 'GMAIL_API_ERROR', err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected failure listing messages');
  }
});
