-- public.users: account identity, Gmail-scoped OAuth credentials, and the Pub/Sub
-- watch checkpoint (contract.md §3). There is no Supabase Auth session anywhere in
-- this app — OAuth is a custom code exchange against Google directly, the backend
-- issues its own session JWT (src/middleware/auth.ts), and every DB access goes
-- through the service-role key (src/db/client.ts). google_id (Google's `sub` claim)
-- is the identity key throughout, not a Supabase auth.users uuid.
create table if not exists public.users (
  google_id text primary key,
  email text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  token_expiry timestamptz not null,
  watch_expiry timestamptz,
  history_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;
-- No policies for authenticated/anon: since there is no Supabase Auth session to
-- derive auth.uid() from, an owner-scoped policy has nothing meaningful to compare
-- against. Access is service-role-only, enforced entirely in application code
-- (every query in src/db filters by google_id already).
