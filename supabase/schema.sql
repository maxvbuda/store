-- Shop Agent — accounts + sessions schema.
-- Paste into the Supabase SQL editor (Project > SQL Editor > New query) and run once.
--
-- Table names are prefixed agent_* so they don't collide with anything
-- already in this Supabase project (e.g. autostore-mvp's own schema, if
-- you're sharing one project across both apps).

create table if not exists public.agent_users (
  id text primary key,
  email text not null unique,
  salt text not null,
  hash text not null,
  created_at timestamptz not null default now(),
  setup jsonb
);

create table if not exists public.agent_sessions (
  token text primary key,
  user_id text not null references public.agent_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_sessions_user_id on public.agent_sessions(user_id);

-- Row Level Security: this app only ever talks to these tables with the
-- Supabase service-role key from the Node server (never from the browser),
-- so RLS stays enabled with no policies — the service role bypasses it, and
-- nothing else can reach these tables at all.
alter table public.agent_users enable row level security;
alter table public.agent_sessions enable row level security;

-- Optional cleanup: sessions older than 30 days are already treated as
-- expired by the app (see lib/auth.js), so this is just housekeeping.
-- Run manually, or wire up with pg_cron / a scheduled Supabase Edge Function
-- if you want it automatic:
--   delete from public.agent_sessions where created_at < now() - interval '30 days';
