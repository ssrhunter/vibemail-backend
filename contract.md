# Contract — Vibemail Engine

Backend for a Gmail-backed email client. Node.js + TypeScript + Express, PostgreSQL via Supabase (schema as plain `.sql` migrations, no ORM), authentication via Supabase Auth's Google OAuth provider. Tests in Vitest.

---

# 1. Acceptance Criteria

The project is complete when all of the following are true:

- All four endpoints in §2 are implemented and behave exactly per this contract, including every typed error case.
- The Vitest suite passes in full — for each endpoint: the success path, a validation failure, and each typed error case listed for it.
- ESLint and `tsc --noEmit` both report zero errors.
- The sequencing rule in §4 has been honored: server logic + passing tests merged first, schema migration reviewed/merged only afterward.

---

# 2. API Endpoint Contracts

## Shared conventions

- Base path: `/api/v1`.
- Success envelope: `{ "data": <payload>, "meta": { "requestId": "<uuid>" } }`.
- Error envelope: `{ "error": { "code": "SCREAMING_SNAKE_CASE", "message": "human-readable", "details": [] }, "meta": { "requestId": "<uuid>" } }`. `details` holds per-field validation problems and is empty otherwise.
- Authenticated endpoints (all except the OAuth callback) require `Authorization: Bearer <supabase_access_token>`. A missing or invalid token always returns `UNAUTHENTICATED` / 401, regardless of endpoint.

## 2.1 `GET /api/v1/auth/google/callback`

OAuth redirect target registered with Google. Exchanges the authorization code for a Supabase session and captures Google's Gmail-scoped tokens.

**Request** — query string:

| Param | Type | Required | Notes |
|---|---|---|---|
| `code` | string | yes | Authorization code from Google's redirect |
| `state` | string | yes | Anti-CSRF state value issued when the OAuth flow started |

**Processing:**
1. Validate `code` and `state` are present.
2. Call `supabase.auth.exchangeCodeForSession(code)`.
3. On success, Supabase returns a session plus `provider_token` (Google access token) and `provider_refresh_token` (Google refresh token, only present on first consent). Upsert both into `users` (see §3), keyed by `google_id`.
4. Return the Supabase session to the caller.

**Response — `200`:**
```json
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "...",
    "expiresAt": "2026-10-13T18:30:00.000Z",
    "user": { "id": "uuid", "email": "user@example.com" }
  },
  "meta": { "requestId": "..." }
}
```

**Typed errors:**

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `code` or `state` missing from the query string |
| `OAUTH_DENIED` | 401 | User declined consent on Google's screen (Google redirects with `error=access_denied`) |
| `OAUTH_EXCHANGE_FAILED` | 502 | `exchangeCodeForSession` rejected the code (expired, already used, state mismatch) |
| `INTERNAL_ERROR` | 500 | Any other unexpected failure (e.g. `users` upsert fails) |

## 2.2 `GET /api/v1/messages`

Lists the authenticated user's messages. Syncs on read: fetches from Gmail live, upserts into Postgres, then returns the stored rows for the requested page.

**Request** — query string:

| Param | Type | Required | Notes |
|---|---|---|---|
| `pageToken` | string | no | Opaque cursor from a previous response's `meta.nextPageToken`; omit for the first page |
| `maxResults` | integer | no | Page size; implementation picks a default and a hard ceiling (flagged open, §5) |
| `label` | string | no | Gmail label id to filter by, e.g. `INBOX`, `UNREAD` |
| `q` | string | no | Gmail search-syntax query string, passed through to the Gmail API |

**Response — `200`:**
```json
{
  "data": [
    {
      "id": "18c9f2a1b2c3d4e5",
      "threadId": "18c9f2a1b2c3d4e5",
      "subject": "Welcome to Vibemail",
      "fromAddress": "noreply@example.com",
      "toAddresses": ["user@example.com"],
      "ccAddresses": [],
      "snippet": "Thanks for signing up...",
      "bodyText": "Thanks for signing up...",
      "bodyHtml": "<p>Thanks for signing up...</p>",
      "labelIds": ["INBOX", "UNREAD"],
      "isUnread": true,
      "hasAttachments": false,
      "attachments": [],
      "internalDate": "2026-10-13T12:00:00.000Z",
      "sizeEstimate": 4096,
      "historyId": "123456"
    }
  ],
  "meta": { "requestId": "...", "nextPageToken": "CiAKGjB..." }
}
```

**Typed errors:**

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired bearer token |
| `VALIDATION_ERROR` | 400 | `maxResults` not a positive integer, or `pageToken` malformed |
| `GMAIL_API_ERROR` | 502 | The live Gmail API call failed (rate limit, token expired, upstream error) |
| `INTERNAL_ERROR` | 500 | Upsert into Postgres failed, or any other unexpected failure |

## 2.3 `POST /api/v1/messages`

Composes and sends a new message, or a reply into an existing thread.

**Request body:**
```json
{
  "to": ["recipient@example.com"],
  "cc": ["cc@example.com"],
  "bcc": [],
  "subject": "Re: Project update",
  "bodyText": "Plain text body",
  "bodyHtml": "<p>HTML body</p>",
  "attachments": [
    { "filename": "report.pdf", "mimeType": "application/pdf", "contentBase64": "JVBERi0x..." }
  ],
  "threadId": "18c9f2a1b2c3d4e5",
  "inReplyTo": "18c9f2a1b2c3d4e5"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string[] | yes | At least one valid email address |
| `cc` | string[] | no | |
| `bcc` | string[] | no | |
| `subject` | string | yes | |
| `bodyText` | string | one of `bodyText`/`bodyHtml` required | Plain-text body |
| `bodyHtml` | string | one of `bodyText`/`bodyHtml` required | HTML body |
| `attachments` | array | no | Each item: `filename`, `mimeType`, `contentBase64`; size ceiling flagged open (§5) |
| `threadId` | string | no | Gmail thread id to reply into |
| `inReplyTo` | string | no | Gmail message id this is replying to (used to set the `In-Reply-To`/`References` MIME headers) |

**Processing:** build a MIME message (multipart if HTML and/or attachments are present), call Gmail `users.messages.send`, upsert the resulting sent message into `messages` (§3), return the stored row.

**Response — `201`:** the created message, same shape as a single item in §2.2's `data` array.

**Typed errors:**

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired bearer token |
| `VALIDATION_ERROR` | 400 | Missing `to`/`subject`, neither `bodyText` nor `bodyHtml` given, invalid email format, attachment exceeds size ceiling |
| `GMAIL_SEND_FAILED` | 502 | Gmail's `messages.send` call failed |
| `INTERNAL_ERROR` | 500 | Upsert into Postgres failed, or any other unexpected failure |

## 2.4 `PATCH /api/v1/messages/read`

Marks a batch of messages as read or unread (adds/removes the `UNREAD` label).

**Request body:**
```json
{ "messageIds": ["18c9f2a1b2c3d4e5", "18c9f2a1b2c3d4e6"], "isRead": true }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `messageIds` | string[] | yes | Non-empty |
| `isRead` | boolean | no | Defaults to `true` (mark read) when omitted, preserving the original mark-as-read-only behavior for existing callers. `false` marks unread instead. |

**Processing:** for each id, call Gmail to remove the `UNREAD` label when `isRead` is `true`, or add it back when `isRead` is `false` (batched where the Gmail API allows), update the matching `messages` row's `label_ids`/`is_read`. Partial failure is not a hard error — report per-id outcome.

**Response — `200`:**
```json
{
  "data": {
    "succeeded": ["18c9f2a1b2c3d4e5"],
    "failed": [{ "id": "18c9f2a1b2c3d4e6", "code": "GMAIL_API_ERROR" }]
  },
  "meta": { "requestId": "..." }
}
```

**Typed errors:**

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired bearer token |
| `VALIDATION_ERROR` | 400 | `messageIds` missing or empty, or `isRead` present but not a boolean |
| `INTERNAL_ERROR` | 500 | Unexpected failure updating Postgres |

Note: individual Gmail-side failures for specific ids are reported inside the `200` response body's `failed` array (code `GMAIL_API_ERROR`), not as a top-level HTTP error — the batch as a whole only fails at the HTTP level for the cases above.

---

# 3. Stored Message Data Model

Every message synced from Gmail is stored as one row in `messages`, keyed on `gmail_id`. Column-by-column mapping to the Gmail API `Message` resource:

| Column | Type | Source in Gmail API response |
|---|---|---|
| `gmail_id` | `text` (PK) | `message.id` |
| `google_id` | `text` (references `users.google_id`) | Not from Gmail — the authenticated user's Google account id |
| `thread_id` | `text` | `message.threadId` |
| `subject` | `text`, nullable | `payload.headers[]` where `name` matches `"Subject"` case-insensitively, that entry's `value` |
| `from_address` | `text`, nullable | `payload.headers[]` where `name` matches `"From"` case-insensitively |
| `to_address` | `text`, nullable | `payload.headers[]` where `name` matches `"To"` case-insensitively — stored as the raw header value (may contain multiple comma-separated addresses), not parsed into an array |
| `snippet` | `text`, nullable | `message.snippet` |
| `body_plain` | `text`, nullable | Base64url-decoded `text/plain` part: walks `payload.parts[]` recursively (skipping parts with a `filename`, i.e. attachments); for a single-part message with no `parts` array, falls back to `payload.body.data` when `payload.mimeType` isn't `text/html` |
| `body_html` | `text`, nullable | Base64url-decoded `text/html` part, same lookup rule as `body_plain` |
| `label_ids` | `text[]` | `message.labelIds` |
| `is_read` | `boolean` (derived, not stored from Gmail directly) | `true` iff `"UNREAD"` is **not** in `label_ids` |
| `is_starred` | `boolean` (derived) | `true` iff `"STARRED"` is in `label_ids` |
| `sent_at` | `timestamptz`, nullable | Parsed from `payload.headers[]` where `name` matches `"Date"` case-insensitively (not from `message.internalDate`) |
| `synced_at` | `timestamptz` | Not from Gmail — set to `now()` on every upsert |
| `created_at` | `timestamptz` | Not from Gmail — set by the column default on first insert only |

Not currently populated (dropped from the original design, not yet rebuilt): `cc_address`, `has_attachments`, `attachments`, `size_estimate`, and a per-message `history_id`. Attachment handling and size tracking are open work, not an oversight — see §5.

A second table, `users`, holds account identity, the Gmail-scoped OAuth credentials, and the Pub/Sub watch checkpoint. Google does not auto-refresh these the way Supabase would, so they're owned and refreshed by this backend directly:

| Column | Type | Notes |
|---|---|---|
| `google_id` | `text` (PK) | Google's stable account id (`sub` claim from the OAuth id_token) |
| `email` | `text` | From the OAuth id_token |
| `access_token_encrypted` | `text` | Google's access token, AES-256-GCM encrypted (`iv:authTag:ciphertext`, base64) before storage — never stored in plaintext |
| `refresh_token_encrypted` | `text` | Google's refresh token, same encryption; only returned by Google on first consent — preserved across subsequent refreshes rather than overwritten with nothing |
| `token_expiry` | `timestamptz` | When `access_token_encrypted` expires and needs refreshing via `refresh_token_encrypted` |
| `watch_expiry` | `timestamptz`, nullable | Expiration of the current Gmail `users.watch` registration |
| `history_id` | `text`, nullable | Mailbox-level sync checkpoint — set from `users.getProfile()` after the initial sync, and from `users.watch`'s response when a watch is (re-)registered |
| `created_at` / `updated_at` | `timestamptz` | Not from Gmail |

Note: there is no separate Supabase Auth session here — `google_id` (not a Supabase `auth.users` uuid) is the identity key throughout, since the OAuth flow is a custom code exchange against Google directly, not Supabase Auth's hosted provider. §2.1's "Processing" steps and response shape still describe the Supabase-Auth-session version of this flow and have not yet been reconciled with this — that's a separate, larger rewrite than this table-naming pass.

---

# 4. Two-Session Build Sequencing Rule

> **Session 1** delivers the server logic for all four endpoints in §2, plus the full Vitest suite, green in CI. Session 1's code may run against a local/dev migration that has not yet been reviewed or merged.
>
> **Session 2** delivers the `.sql` schema migration for `messages` and `users` (§3).
>
> **The schema migration must not be reviewed or merged until Session 1's server-logic PR has already merged with passing tests.** Server logic and tests ship first; schema review/merge happens strictly after.

---

# 5. Open Items (flagged, not resolved by this contract)

- Exact `maxResults` default and hard ceiling for `GET /messages` — not specified here; pick a concrete default (e.g. 50) and ceiling (e.g. 100) during implementation.
- Attachment size ceiling for `POST /messages` — not specified here; needs a concrete byte limit (and matching `VALIDATION_ERROR` behavior) before implementation.
- Google `access_token` refresh strategy — `users.token_expiry` exists to support refreshing, but the refresh algorithm (when to refresh, retry-on-401 vs. proactive) is not defined here.
- Attachment handling (`cc_address`, `has_attachments`, `attachments`, `size_estimate`, per-message `history_id`) was dropped from §3's `messages` table when it was rewritten to match the actual sync implementation — needs its own design pass, not just a schema add-back.
- §2.1's OAuth callback "Processing" steps and response shape still describe Supabase Auth's `exchangeCodeForSession` flow, which doesn't match §3's `users` table (keyed by `google_id`, not a Supabase session). Needs a dedicated rewrite once the actual HTTP handler (build unit 6) is built.
