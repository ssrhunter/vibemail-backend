import { google } from 'googleapis';
import { getAuthenticatedClient } from '../providers/gmail/auth';
import { fetchFullMessage, normalizeMessage } from '../sync';
import { upsertMessages, MessageRow } from '../db/messages';
import { ProviderError, ProviderErrorCode } from '../types/provider';

export interface SendMessageInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}

function buildRawMessage(input: SendMessageInput): string {
  const lines = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    input.body,
  ];
  return lines.join('\r\n');
}

function encodeRfc2822Base64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Sends a plain-text message (optionally into an existing thread) via Gmail on behalf
 *  of googleId, then stores the sent message. messages.send's own response is minimal
 *  (id/threadId/labelIds only, no headers or body), so the full message is re-fetched
 *  via messages.get before normalizing — mirroring unit 3's sync layer. */
export async function sendMessage(googleId: string, input: SendMessageInput): Promise<MessageRow> {
  const client = await getAuthenticatedClient(googleId);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const raw = encodeRfc2822Base64Url(buildRawMessage(input));

  let sendResponse;
  try {
    sendResponse = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    });
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Failed to send Gmail message', err);
  }

  const sentId = sendResponse.data.id;
  if (!sentId) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, 'Gmail send response missing message id');
  }

  const full = await fetchFullMessage(gmail, sentId);
  const row = normalizeMessage(full, googleId);
  await upsertMessages([row]);
  return row;
}
