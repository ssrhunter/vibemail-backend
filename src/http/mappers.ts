import { MessageRow } from '../db/messages';

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

export function toApiMessage(row: MessageRow): ApiMessage {
  return {
    id: row.gmail_id,
    threadId: row.thread_id,
    subject: row.subject,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    snippet: row.snippet,
    bodyPlain: row.body_plain,
    bodyHtml: row.body_html,
    labelIds: row.label_ids,
    isRead: row.is_read,
    isStarred: row.is_starred,
    sentAt: row.sent_at,
  };
}
