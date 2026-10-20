-- public.messages: synced Gmail messages (contract.md §3 data model).
-- Primary key is (user_id, id) rather than contract.md's literal single-column
-- id PK: Gmail message IDs are unique within one mailbox but not guaranteed
-- globally unique across different users' mailboxes, and RLS needs a
-- user_id-anchored row regardless.
create table if not exists public.messages (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  thread_id text not null,
  subject text,
  from_address text,
  to_addresses text[] not null,
  cc_addresses text[],
  snippet text,
  body_text text,
  body_html text,
  label_ids text[] not null,
  is_unread boolean not null,
  has_attachments boolean not null,
  attachments jsonb,
  internal_date timestamptz not null,
  size_estimate integer,
  history_id text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists messages_user_id_internal_date_idx
  on public.messages (user_id, internal_date desc);

alter table public.messages enable row level security;

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own" on public.messages
  for select
  using (auth.uid() = user_id);
