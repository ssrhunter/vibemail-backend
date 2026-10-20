import type { VercelRequest, VercelResponse } from '@vercel/node';
import { renewExpiringWatches } from '../../src/cron/renewWatch';
import { sendError, sendSuccess } from '../../src/http/respond';

/** Vercel invokes cron-triggered functions with `Authorization: Bearer <CRON_SECRET>`
 *  when that env var is set on the project — verifying it stops anyone who finds this
 *  URL from triggering mass watch renewal on demand, the same reasoning as the Pub/Sub
 *  webhook's verification token. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret || req.headers.authorization !== `Bearer ${expectedSecret}`) {
    sendError(res, 401, 'UNAUTHENTICATED', 'Invalid or missing cron secret');
    return;
  }

  try {
    const result = await renewExpiringWatches();
    sendSuccess(res, 200, result);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'Unexpected failure renewing watches');
  }
}
