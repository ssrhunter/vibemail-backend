import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withAuth } from '../../../src/middleware/auth';
import { sendError, sendSuccess } from '../../../src/http/respond';
import { toApiMessage } from '../../../src/http/mappers';
import { sendMessage, SendMessageInput, SendAttachment } from '../../../src/send';
import { ProviderError, ProviderErrorCode } from '../../../src/types/provider';

interface ValidationIssue {
  field: string;
  issue: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isAttachment(value: unknown): value is SendAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.filename === 'string' && typeof v.mimeType === 'string' && typeof v.contentBase64 === 'string';
}

function validateSendBody(body: unknown): { value: SendMessageInput } | { errors: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  if (typeof body !== 'object' || body === null) {
    return { errors: [{ field: 'body', issue: 'must be a JSON object' }] };
  }
  const b = body as Record<string, unknown>;

  if (!isStringArray(b.to) || b.to.length === 0) {
    errors.push({ field: 'to', issue: 'must be a non-empty array of email addresses' });
  } else if (!b.to.every((addr) => EMAIL_PATTERN.test(addr))) {
    errors.push({ field: 'to', issue: 'must contain only valid email addresses' });
  }
  if (b.cc !== undefined && !isStringArray(b.cc)) errors.push({ field: 'cc', issue: 'must be an array of strings' });
  if (b.bcc !== undefined && !isStringArray(b.bcc)) errors.push({ field: 'bcc', issue: 'must be an array of strings' });

  if (typeof b.subject !== 'string' || b.subject.length === 0) {
    errors.push({ field: 'subject', issue: 'required' });
  }

  const bodyText = typeof b.bodyText === 'string' ? b.bodyText : undefined;
  const bodyHtml = typeof b.bodyHtml === 'string' ? b.bodyHtml : undefined;
  if (!bodyText && !bodyHtml) {
    errors.push({ field: 'bodyText', issue: 'either bodyText or bodyHtml is required' });
  }

  let attachments: SendAttachment[] | undefined;
  if (b.attachments !== undefined) {
    if (!Array.isArray(b.attachments) || !b.attachments.every(isAttachment)) {
      errors.push({ field: 'attachments', issue: 'each item requires filename, mimeType, contentBase64' });
    } else {
      attachments = b.attachments;
    }
  }

  if (b.threadId !== undefined && typeof b.threadId !== 'string') errors.push({ field: 'threadId', issue: 'must be a string' });
  if (b.inReplyTo !== undefined && typeof b.inReplyTo !== 'string') {
    errors.push({ field: 'inReplyTo', issue: 'must be a string' });
  }

  if (errors.length > 0) return { errors };

  return {
    value: {
      to: b.to as string[],
      cc: b.cc as string[] | undefined,
      bcc: b.bcc as string[] | undefined,
      subject: b.subject as string,
      bodyText,
      bodyHtml,
      attachments,
      threadId: b.threadId as string | undefined,
      inReplyTo: b.inReplyTo as string | undefined,
    },
  };
}

export default withAuth(async (req: VercelRequest, res: VercelResponse, googleId: string): Promise<void> => {
  const validated = validateSendBody(req.body as unknown);
  if ('errors' in validated) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', validated.errors);
    return;
  }

  try {
    const row = await sendMessage(googleId, validated.value);
    sendSuccess(res, 201, toApiMessage(row));
  } catch (err) {
    if (err instanceof ProviderError && err.code === ProviderErrorCode.UPSTREAM_ERROR) {
      sendError(res, 502, 'GMAIL_SEND_FAILED', err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected failure sending the message');
  }
});
