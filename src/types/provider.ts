export interface ProviderTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope?: string;
  tokenType?: string;
}

export interface ProviderAttachment {
  filename: string;
  mimeType: string;
  size?: number;
  attachmentRef: string; // opaque — provider-specific id needed to fetch content later
}

export interface ProviderMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  snippet: string;
  bodyText?: string;
  bodyHtml?: string;
  isRead: boolean;
  hasAttachments: boolean;
  attachments: ProviderAttachment[];
  sentAt: Date;
  sizeEstimate?: number;
  providerMetadata?: Record<string, unknown>; // e.g. Gmail's historyId — never a named field here
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: { filename: string; mimeType: string; contentBase64: string }[];
  threadId?: string;
  inReplyTo?: string;
}

export enum ProviderErrorCode {
  AUTH_ERROR = 'AUTH_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_FOUND = 'NOT_FOUND',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  INVALID_TOKEN = 'INVALID_TOKEN',
}

export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode, message: string, public cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ListMessagesOptions {
  cursor?: string;
  pageSize?: number;
}

export interface ListMessagesResult {
  messages: ProviderMessage[];
  nextCursor?: string;
}

// Optional watch/delta-sync capability (Gmail-specific; IMAP providers may omit)
export interface WatchRegistration {
  expiresAt: Date;
  providerMetadata?: Record<string, unknown>;
}

export interface HistoryDelta {
  messages: ProviderMessage[];
  deletedMessageIds: string[];
  nextCursor: string;
  // true when the provider's change cursor expired (e.g. Gmail historyId 404) and callers must fall back to a full sync
  resyncRequired: boolean;
}

export interface EmailProvider {
  // OAuth
  getAuthUrl(state: string): string;
  exchangeCodeForTokens(code: string): Promise<ProviderTokens>;
  refreshAccessToken(refreshToken: string): Promise<ProviderTokens>;

  // Messages
  listMessages(options?: ListMessagesOptions): Promise<ListMessagesResult>;
  sendMessage(message: OutgoingMessage): Promise<ProviderMessage>;
  setMessageReadStatus(messageId: string, isRead: boolean): Promise<void>;

  // Optional: push notifications + incremental sync
  registerWatch?(): Promise<WatchRegistration>;
  getHistoryDelta?(sinceCursor: string): Promise<HistoryDelta>;
}
