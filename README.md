# Vibemail Backend

A data-liberation sync engine for Gmail: it connects to a user's Gmail account via OAuth2, syncs their mail into Postgres (Supabase), and exposes it through a REST API. New mail arrives in near real time via a Gmail Pub/Sub push subscription rather than polling.

## What it does

- **Google OAuth login** — starts the consent flow, verifies the callback with a real CSRF-protected state (httpOnly cookie), and issues the app's own session JWT.
- **Message sync** — on first login, pulls the 50 most recent inbox messages into Postgres. After that, a Gmail Pub/Sub webhook keeps it current by fetching only the delta since the last known `historyId` (falling back to a full resync if that checkpoint has expired).
- **List messages** — cursor-paginated, with best-effort `label` and free-text `q` filters over the already-synced data.
- **Send messages** — compose a new message or reply into an existing thread, with `cc`/`bcc`, HTML bodies, and attachments.
- **Mark read/unread** — batch-update a set of messages, applied both to Gmail (via label changes) and to the local copy.
- **Scheduled watch renewal** — a cron job keeps the Gmail watch subscription (which expires every ~7 days) alive before it lapses.

## Tech stack

- **Node.js** + **TypeScript** (strict mode)
- **`googleapis`** — all Gmail API access goes through its OAuth2 client, which also handles token refresh
- **Supabase** — Postgres database, accessed via `@supabase/supabase-js` with a service-role key; schema/migrations are generated and managed via the Supabase CLI
- **Vercel** — deployment target; every route under `api/` is an individual serverless function, plus a scheduled Vercel Cron job
- **Vitest** — test runner; integration tests run against a real Supabase instance (no database mocking) with the Gmail API itself mocked

## Architecture

```
api/                      Thin Vercel function entry points (one file = one route)
  v1/auth/google/            GET  /api/v1/auth/google            — start OAuth
                              GET  /api/v1/auth/google/callback   — OAuth callback
  v1/messages/                GET  /api/v1/messages               — list (paginated)
                              POST /api/v1/messages               — send
                              PATCH /api/v1/messages/read         — mark read/unread
  webhook/gmail.ts            POST /api/webhook/gmail             — Pub/Sub push receiver
  cron/renew-watch.ts         GET  /api/cron/renew-watch          — scheduled watch renewal

src/                       Shared logic the routes above call into
  providers/gmail/            OAuth2 client, token encryption, Gmail watch registration
  sync/                       Initial sync, incremental sync, read/unread status
  send/                       Outgoing MIME construction + Gmail send
  webhook/                    Pub/Sub notification handling (ack-first, then async)
  cron/                       Watch-renewal logic
  db/                         All Supabase access, typed against the generated schema
  middleware/                 Session JWT issuance/verification
  http/                       Shared response envelope + request/cookie helpers
  types/                      Provider-agnostic interface + generated Supabase types
```

Every response uses one consistent envelope: `{ data, meta }` on success, `{ error: { code, message, details }, meta }` on failure.

## Getting started

### Prerequisites

- Node.js 20+
- A Google Cloud project with the Gmail API enabled, an OAuth 2.0 **Web application** client, and a Pub/Sub topic (with Gmail granted publish permission on it)
- A Supabase project

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth2 client credentials |
| `GOOGLE_REDIRECT_URI` | Must match the callback URI registered on the OAuth client |
| `GOOGLE_PUBSUB_TOPIC` | The topic Gmail publishes push notifications to |
| `GOOGLE_PUBSUB_VERIFICATION_TOKEN` | Shared secret checked on incoming webhook requests |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase project connection (service-role key — all writes go through it) |
| `JWT_SECRET` | Signs this app's own session tokens (unrelated to Google) |
| `ENCRYPTION_KEY` | Base64-encoded 32-byte key; encrypts stored Gmail tokens at rest (AES-256-GCM) |
| `CRON_SECRET` | Checked on the scheduled watch-renewal endpoint |
| `FRONTEND_URL` | Where the client app lives (CORS/redirect target) |

### Run locally

```bash
npx vercel dev
```

Serves every route under `api/` locally. There's no `build` script in `package.json` by design — adding one causes Vercel's zero-config detection to misdetect this as a static site (see `CLAUDE.md`'s Commands section for the full explanation).

### Common commands

```bash
npx tsc --noEmit       # type-check (also: npm run typecheck)
npm test                # run the full Vitest suite once
npx vitest               # run the suite in watch mode
npm run db:types         # regenerate src/types/database.ts from the live Supabase schema
npm run db:push          # push local schema migrations to Supabase
```

### Testing

Unit tests cover pure logic (message normalization, encryption) with no I/O. Integration tests exercise real route handlers with the Gmail API mocked but Supabase **not** mocked — they read and write a real database, so `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` must point at a reachable project before running `npm test`.

A Postman collection at [`docs/vibemail-api.postman_collection.json`](docs/vibemail-api.postman_collection.json) covers every endpoint's happy path and typed error cases for manual/exploratory testing against a running server.

## Deployment

Deployed on Vercel. In addition to the serverless functions under `api/`, `vercel.json` registers a daily cron job for watch renewal. All variables listed above need to be set in the Vercel project's environment variables (not just locally) for the deployed app to function — Preview and Production are configured independently.

## Project documents

- [`contract.md`](contract.md) — the binding API contract: request/response shapes, typed errors, and the Gmail→Postgres data model.
- [`build_sequence.md`](build_sequence.md) — the build order this project was implemented against.
- [`CLAUDE.md`](CLAUDE.md) — development conventions and architectural notes for AI-assisted work in this repo.

contract.md §5 ("Open Items") tracks known gaps and unresolved design questions that haven't been closed out yet.
