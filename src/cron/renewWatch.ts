import { getAuthenticatedClient, registerWatch } from '../providers/gmail/auth';
import { getUsersWithExpiringWatch } from '../db/users';

const RENEWAL_WINDOW_HOURS = 24;

export interface RenewWatchResult {
  renewed: string[];
  failed: { googleId: string; error: string }[];
}

/** Renews the Gmail Pub/Sub watch for every user whose watch_expiry is already past or
 *  due within the next 24 hours, so push notifications (unit 4) never silently lapse.
 *  Reuses registerWatch from unit 2 rather than re-implementing the watch call. */
export async function renewExpiringWatches(): Promise<RenewWatchResult> {
  const dueUsers = await getUsersWithExpiringWatch(RENEWAL_WINDOW_HOURS);
  const renewed: string[] = [];
  const failed: { googleId: string; error: string }[] = [];

  for (const { googleId } of dueUsers) {
    try {
      const client = await getAuthenticatedClient(googleId);
      await registerWatch(client, googleId);
      renewed.push(googleId);
    } catch (err) {
      failed.push({ googleId, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  return { renewed, failed };
}
