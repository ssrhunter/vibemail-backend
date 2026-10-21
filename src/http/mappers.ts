import { MessageInsert } from '../db';

export interface ApiMessage {
  id: string;
  threadId: string;
  subject: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  snippet: string | null;
  bodyPlain: string | null;
  bodyHtml: string | null;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  sentAt: string | null;
}

export function toApiMessage(row: MessageInsert): ApiMessage {
  return {
    id: row.gmail_id,
    threadId: row.thread_id,
    subject: row.subject ?? null,
    fromAddress: row.from_address ?? null,
    toAddress: row.to_address ?? null,
    snippet: row.snippet ?? null,
    bodyPlain: row.body_plain ?? null,
    bodyHtml: row.body_html ?? null,
    labelIds: row.label_ids,
    isRead: row.is_read,
    isStarred: row.is_starred,
    sentAt: row.sent_at ?? null,
  };
}
