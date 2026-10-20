# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A data liberation sync engine: it extracts a user's Gmail data via OAuth2 into Supabase (Postgres) and exposes it through a REST API at `/api/v1`, deployed as Vercel serverless functions.

## Stack

- Node 20, TypeScript in strict mode
- `googleapis` for all Gmail API access
- Supabase JS client for Postgres access
- Vitest + Supertest for testing
- Vercel (serverless functions + deployment)

## Project state

This is a pre-implementation scaffold: `src/`, `api/`, `tests/`, and `docs/` exist as empty directory trees (no source files yet). Two planning documents at the repo root are the actual specification — read both before writing any code:

- **`contract.md`** — binding API contract: request/response shapes and typed errors for the four endpoints, the full Gmail→Postgres data model, and acceptance criteria.
- **`build_sequence.md`** — the mandatory, atomic build order (7 units). Each unit has a one-sentence verify step that must pass before starting the next unit — do not reorder or parallelize across units without being asked.

READ BOTH FILES BEFORE WRITING ANY CODE.

Note: `contract.md` was written assuming Supabase Auth's hosted Google OAuth provider, but `.env.example` (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` + `JWT_SECRET` + `ENCRYPTION_KEY`) points to a custom, self-managed OAuth code exchange with the backend issuing its own JWT and encrypting stored Google refresh tokens itself. Treat the env vars as the current source of truth for the auth design and flag the mismatch to the user rather than silently picking one.

## Commands

`npm test` runs the real Vitest suite. There is deliberately **no `build` script** in `package.json` — with no `framework` set in `vercel.json`, Vercel's zero-config detection treats a package.json `build` script as a static-site build step and matches the whole project root to `@vercel/static-build` *in addition to* the actual `api/*.ts` functions (which `@vercel/node` compiles independently and don't need it at all). That phantom static-build match is what breaks `vercel dev`/`vercel build` (it tries to install with yarn, which isn't on this machine, and separately fails on `STATIC_BUILD_NO_OUT_DIR` even when it does install). Don't re-add a `build` script for that reason — use `typecheck` instead:

```bash
npx tsc --noEmit                          # type-check (strict mode is on) — also npm run typecheck
npm test                                   # run the full suite once (vitest run)
npx vitest                                 # run the full suite in watch mode
npx vitest run tests/unit/<file>.test.ts   # run a single test file
npx vitest run -t "<test name>"            # run tests matching a name
npx vercel pull --yes --environment preview  # first-time/occasional: sync local .vercel/ with the dashboard project
npx vercel dev                             # serve api/ locally (Vercel dev server)
```

ESLint is not a dependency of this project — there is no lint command to run. `dev` in `package.json` (`ts-node src/index.ts`) is stale — `src/index.ts` doesn't exist; this is a Vercel serverless app, use `npx vercel dev` instead, not `npm run dev`.

## Architecture

This backend runs as **Vercel serverless functions**: every file under `api/` is a deployed HTTP route (file-based routing), while `src/` holds the shared logic those thin route handlers call into. `tsconfig.json` compiles both `src/**` and `api/**` together (strict, CommonJS, ES2020).

The `src/` layout mirrors `build_sequence.md`'s unit order directly:

- `src/providers/{gmail,imap}` — provider abstraction (unit 1). Gmail is the first implementation; the interface is written to allow an IMAP provider alongside it later, so provider-specific logic must stay behind the shared interface rather than leaking into `sync`/`send`/webhook code.
- `src/sync` — sync-and-read layer (unit 3): fetches from the provider and upserts into Postgres (`contract.md` §3 `messages` table).
- `src/webhook` + `api/webhook` — Gmail Pub/Sub push-notification receiver (unit 4). `.env.example`'s `GOOGLE_PUBSUB_TOPIC`/`GOOGLE_PUBSUB_VERIFICATION_TOKEN` confirm this is push-based (Gmail `watch()` + Cloud Pub/Sub), not polling; a notification carries a `historyId` that `src/sync` uses to fetch just the delta.
- `src/send` — send layer (unit 5), builds outgoing MIME and calls the provider's send method.
- `api/v1/auth/google`, `api/v1/messages` — the four HTTP endpoints from `contract.md` §2 (unit 6).
- `src/db` — Supabase/Postgres access (service-role key, per `.env.example`'s `SUPABASE_SERVICE_ROLE_KEY`).
- `src/middleware` — request-level auth (bearer token verification).
- `src/cron` + `api/cron` — a scheduled Vercel cron job, most likely for refreshing Google's access token using the stored refresh token before it expires.
- `src/types` — shared TypeScript types, almost certainly including the `contract.md` §3 message shape.

`tests/unit` and `tests/integration` separate provider/logic unit tests from the build sequence's unit 7 ("full suite passes with no skipped tests against live Supabase") — integration tests are expected to hit a real Supabase instance, not a mock.

## Two-session architecture

Work is split across two branches with disjoint ownership:

- **Server logic session** — `main` branch, owns `src/` and `api/`.
- **Schema session** — `schema` branch, owns `migrations/` and `types/`.

(Note: the current scaffold doesn't yet have top-level `migrations/` or `types/` directories — there's a `src/types/` instead, and no `migrations/` directory exists. That restructuring hasn't happened yet; don't assume these paths exist until someone does it.)

## Sequencing rule

The schema session cannot be merged until the server logic session's tests pass. Never merge `schema` ahead of a green test run on `main`.

## Never-do rules

- Never use `any` as a TypeScript type.
- Never poll the Gmail API for new messages — use Pub/Sub push webhooks.
- Never store OAuth tokens in plaintext.
- Never make Gmail API calls without going through the `googleapis` OAuth2 client — it handles token refresh automatically; a hand-rolled fetch/token path won't.
- Never write to `src/db/` from the schema session.
- Never merge the schema session before `npm test` exits `0`. (Today `npm test` is a stub that always exits `1` — see Commands — so this gate isn't meaningful until that script is wired to the real Vitest suite.)
- Never hardcode credentials.

## Coding conventions

- All errors use the `contract.md` error envelope shape (`{ error: { code, message, details } }`, alongside `{ data, meta }` for success).
- Cursor-based pagination on all list endpoints.
- `/api/v1` base path on all client-facing endpoints.
- JWT Bearer token authentication on all endpoints except the OAuth callback.
- The Pub/Sub webhook endpoint lives at `/webhook/gmail`, not under `/api/v1`. (Note: the current scaffold has this handler under `api/webhook`, which Vercel's file-based routing would serve at `/api/webhook`, not `/webhook/gmail` — getting the literal `/webhook/gmail` path needs either moving the handler or adding a `vercel.json` rewrite, neither of which exists yet.)

## Housekeeping note

`package.json`'s `devDependencies` include `npm` and `install` as installed packages — these aren't used anywhere and are very likely an accidental `npm install` mistake, not an intentional dependency.
