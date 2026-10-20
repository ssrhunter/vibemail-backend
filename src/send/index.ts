import { randomUUID } from 'crypto';
import { google, gmail_v1 } from 'googleapis';
import { getAuthenticatedClient } from '../providers/gmail/auth';
import { fetchFullMessage, normalizeMessage } from '../sync';
import { upsertMessages, MessageRow } from '../db/messages';
import { ProviderError, ProviderErrorCode } from '../types/provider';

export interface SendAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface SendMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: SendAttachment[];
  threadId?: string;
  inReplyTo?: string;
}

function addressHeader(name: string, addresses?: string[]): string | null {
  if (!addresses || addresses.length === 0) return null;
  return `${name}: ${addresses.join(', ')}`;
}

function randomBoundary(): string {
  return `vibemail_${randomUUID().replace(/-/g, '')}`;
}

/** text/plain (+ optional text/html as multipart/alternative) — the body of the message,
 *  without its own top-level MIME-Version/recipient headers (those are added by the caller). */
function buildBodyPart(bodyText: string, bodyHtml: string | undefined): string {
  if (!bodyHtml) {
    return ['Content-Type: text/plain; charset="UTF-8"', '', bodyText].join('\r\n');
  }
  const boundary = randomBoundary();
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    bodyHtml,
    `--${boundary}--`,
  ].join('\r\n');
}

function buildMimeMessage(input: SendMessageInput, inReplyToMessageIdHeader: string | null): string {
  const headers = [`To: ${input.to.join(', ')}`];
  const ccHeader = addressHeader('Cc', input.cc);
  if (ccHeader) headers.push(ccHeader);
  const bccHeader = addressHeader('Bcc', input.bcc);
  if (bccHeader) headers.push(bccHeader);
  headers.push(`Subject: ${input.subject}`, 'MIME-Version: 1.0');
  if (inReplyToMessageIdHeader) {
    headers.push(`In-Reply-To: ${inReplyToMessageIdHeader}`, `References: ${inReplyToMessageIdHeader}`);
  }

  const bodyText = input.bodyText ?? '';
  const bodyPart = buildBodyPart(bodyText, input.bodyHtml);

  if (!input.attachments || input.attachments.length === 0) {
    // bodyPart already starts with its own Content-Type header — fold it straight into
    // the top-level headers rather than nesting an unnecessary multipart/mixed wrapper.
    return headers.join('\r\n') + '\r\n' + bodyPart;
  }

  const mixedBoundary = randomBoundary();
  const parts = [`--${mixedBoundary}`, bodyPart];
  for (const attachment of input.attachments) {
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      attachment.contentBase64
    );
  }
  parts.push(`--${mixedBoundary}--`);

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

function encodeBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** `inReplyTo` is a Gmail message id, not an RFC 2822 Message-ID — those are different
 *  values (e.g. `18c9f2a1b2c3d4e5` vs `<CAO...@mail.gmail.com>`). The In-Reply-To/References
 *  headers must carry the real Message-ID, so it's resolved via a metadata-only fetch
 *  rather than used directly. */
async function resolveMessageIdHeader(gmail: gmail_v1.Gmail, gmailMessageId: string): Promise<string | null> {
  let res;
  try {
    res = await gmail.users.messages.get({
      userId: 'me',
      id: gmailMessageId,
      format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });
  } catch (err) {
    throw new ProviderError(ProviderErrorCode.UPSTREAM_ERROR, `Failed to resolve Message-ID for ${gmailMessageId}`, err);
  }
  const header = res.data.payload?.headers?.find((h) => h.name?.toLowerCase() === 'message-id');
  return header?.value ?? null;
}

/** Sends a message (optionally multipart with HTML and/or attachments, optionally into an
 *  existing thread/reply) via Gmail on behalf of googleId, then stores the sent message.
 *  messages.send's own response is minimal (id/threadId/labelIds only, no headers or body),
 *  so the full message is re-fetched via messages.get before normalizing — mirroring unit
 *  3's sync layer. */
export async function sendMessage(googleId: string, input: SendMessageInput): Promise<MessageRow> {
  const client = await getAuthenticatedClient(googleId);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const inReplyToMessageIdHeader = input.inReplyTo ? await resolveMessageIdHeader(gmail, input.inReplyTo) : null;
  const raw = encodeBase64Url(buildMimeMessage(input, inReplyToMessageIdHeader));

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
