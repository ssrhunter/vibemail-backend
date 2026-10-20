-- public.messages: synced Gmail messages, keyed on gmail_id (contract.md §3).
-- Column set and types match src/db/messages.ts's MessageRow exactly, including the
-- single-column PK: upsertMessages() upserts with { onConflict: 'gmail_id' }, so a
-- composite key would break that upsert.
create table if not exists public.messages (
  gmail_id text primary key,
  google_id text not null references public.users (google_id) on delete cascade,
  thread_id text not null,
  subject text,
  from_address text,
  to_address text,
  snippet text,
  body_plain text,
  body_html text,
  label_ids text[] not null,
  is_read boolean not null,
  is_starred boolean not null,
  sent_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Matches listMessagesPage's query shape exactly: .eq('google_id', ...)
-- .order('sent_at', desc).lt('sent_at', cursor).limit(...).
create index if not exists messages_google_id_sent_at_idx
  on public.messages (google_id, sent_at desc);

-- contract.md: synced_at is "set to now() on every upsert" — upsertMessages() doesn't
-- set it explicitly in the row payload, so a plain column default (which only fires on
-- INSERT) isn't enough. This trigger guarantees it on every insert or update.
create or replace function public.set_messages_synced_at()
returns trigger as $$
begin
  new.synced_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists messages_set_synced_at on public.messages;
create trigger messages_set_synced_at
  before insert or update on public.messages
  for each row
  execute function public.set_messages_synced_at();

alter table public.messages enable row level security;
-- Same reasoning as public.users: no Supabase Auth session exists to scope an owner
-- policy to, so this is service-role-only rather than an auth.uid() = google_id policy.
