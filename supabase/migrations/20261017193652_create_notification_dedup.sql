-- public.gmail_notifications_processed: dedup log for the Pub/Sub webhook
-- (build_sequence.md unit 4). Lets the webhook handler check-and-skip a
-- historyId it has already processed, so a redelivered push can't double-apply
-- a delta sync.
create table if not exists public.gmail_notifications_processed (
  user_id uuid not null references auth.users (id) on delete cascade,
  history_id text not null,
  processed_at timestamptz not null default now(),
  primary key (user_id, history_id)
);

alter table public.gmail_notifications_processed enable row level security;
-- Intentionally no policies for authenticated/anon: this is internal
-- bookkeeping, not user-facing data. Only the service role can touch it.
