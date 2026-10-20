import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { google, gmail_v1 } from 'googleapis';
import { getAuthenticatedClient } from '../providers/gmail/auth';
import { getUserByEmail, updateHistoryId } from '../db/users';
import { upsertMessages, MessageRow } from '../db/messages';
import { runInitialSync, fetchFullMessage, normalizeMessage } from '../sync';
import { ProviderError, ProviderErrorCode } from '../types/provider';

interface PubSubPushBody {
  message?: { data?: string };
  subscription?: string;
}

interface GmailNotification {
  emailAddress: string;
  historyId: string;
}

function decodeNotification(body: PubSubPushBody): GmailNotification {
  const data = body.message?.data;
  if (!data) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Pub/Sub push payload missing message.data');
  }
  const decoded = Buffer.from(data, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(decoded);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { emailAddress?: unknown }).emailAddress !== 'string' ||
    typeof (parsed as { historyId?: unknown }).historyId !== 'string'
  ) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Decoded Pub/Sub payload missing emailAddress/historyId');
  }
  const notification = parsed as GmailNotification;
  return { emailAddress: notification.emailAddress, historyId: notification.historyId };
}

function getHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  const response = (err as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null || !('status' in response)) return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Walks every page of history.list since storedHistoryId, collecting the ids of any
 *  message that was added or had labels change. Returns resyncRequired=true when Gmail
 *  404s because storedHistoryId is stale/expired, per the Gmail API's own documented
 *  fallback behavior. */
async function collectHistoryMessageIds(
  gmail: gmail_v1.Gmail,
  startHistoryId: string
): Promise<{ ids: string[]; resyncRequired: boolean }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;

  do {
    let page;
    try {
      page = await gmail.users.history.list({ userId: 'me', startHistoryId, pageToken });
    } catch (err) {
      if (getHttpStatus(err) === 404) {
        return { ids: [], resyncRequired: true };
      }
      throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Failed to list Gmail history', err);
    }
    for (const record of page.data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
      for (const labelAdded of record.labelsAdded ?? []) {
        if (labelAdded.message?.id) ids.add(labelAdded.message.id);
      }
      for (const labelRemoved of record.labelsRemoved ?? []) {
        if (labelRemoved.message?.id) ids.add(labelRemoved.message.id);
      }
    }
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { ids: Array.from(ids), resyncRequired: false };
}

async function syncHistoryDelta(googleId: string, storedHistoryId: string | null, notificationHistoryId: string): Promise<void> {
  if (!storedHistoryId) {
    // No checkpoint yet for this user — nothing to take a delta from.
    await runInitialSync(googleId);
    return;
  }

  const client = await getAuthenticatedClient(googleId);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const { ids, resyncRequired } = await collectHistoryMessageIds(gmail, storedHistoryId);
  if (resyncRequired) {
    // runInitialSync records its own checkpoint via users.getProfile(), so return here
    // rather than also writing the (now-irrelevant) notification historyId below.
    await runInitialSync(googleId);
    return;
  }

  const rows: MessageRow[] = [];
  for (const id of ids) {
    const raw = await fetchFullMessage(gmail, id);
    rows.push(normalizeMessage(raw, googleId));
  }
  await upsertMessages(rows);
  await updateHistoryId(googleId, notificationHistoryId);
}

async function processNotification(notification: GmailNotification): Promise<void> {
  const user = await getUserByEmail(notification.emailAddress);
  if (!user) return; // Notification for an account we don't have on file — nothing to do.
  await syncHistoryDelta(user.googleId, user.historyId, notification.historyId);
}

/** Vercel entry point for Gmail's Pub/Sub push subscription. Verifies the push
 *  verification token, acknowledges with 200 immediately, then continues the actual
 *  history-delta sync via waitUntil so the work reliably finishes after the response
 *  is sent (a plain `await` after res.end() is not guaranteed to run to completion on
 *  Vercel's serverless runtime). */
export default async function handleGmailWebhook(req: VercelRequest, res: VercelResponse): Promise<void> {
  const expectedToken = process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'invalid pubsub verification token' } });
    return;
  }

  let notification: GmailNotification;
  try {
    notification = decodeNotification(req.body as PubSubPushBody);
  } catch {
    // Malformed payload: ack so Pub/Sub stops redelivering something we can never
    // process, but there's nothing further to do.
    res.status(200).end();
    return;
  }

  res.status(200).end();
  waitUntil(processNotification(notification));
}
