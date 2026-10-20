-- public.users: per-user Gmail watch/sync state (not identity, not credentials).
-- Identity lives in auth.users (Supabase-hosted Google OAuth); this table is a
-- 1:1 extension for app-specific state that auth.users has no room for.
create table if not exists public.users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  watch_history_id text,
  watch_expiration timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;

drop policy if exists "users_select_own" on public.users;
create policy "users_select_own" on public.users
  for select
  using (auth.uid() = user_id);

-- public.google_oauth_tokens: raw Gmail-scoped OAuth credentials (contract.md §3).
-- access_token/refresh_token hold app-layer ciphertext (encrypted with ENCRYPTION_KEY
-- in src/), never plaintext. refresh_token is only returned by Google on first
-- consent, so upsert logic in src/ must not overwrite it with null on re-auth.
create table if not exists public.google_oauth_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token text,
  refresh_token text,
  scope text,
  expires_at timestamptz
);

alter table public.google_oauth_tokens enable row level security;
-- Intentionally no policies for authenticated/anon: only the service role
-- (which bypasses RLS) may ever read or write raw OAuth tokens.
