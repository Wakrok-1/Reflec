-- Your Reflection — Sprint 0 core schema
--
-- Supabase's built-in `auth.users` table is the source of truth for
-- accounts, so there is no separate public `users` table. `profiles` is a
-- 1:1 extension of `auth.users` holding the Character Profile data
-- described in PRD section 5.2.
--
-- Every table carries a `user_id` referencing `auth.users(id)` and is
-- protected by row-level security so one account can never read or write
-- another account's data (PRD section 2: "full multi-user accounts from
-- day one").

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- profiles — the Character Profile (PRD 5.2)
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  age integer,
  class text,
  strengths jsonb not null default '[]'::jsonb,
  philosophy text,
  favourites jsonb not null default '{}'::jsonb,
  core_values jsonb not null default '[]'::jsonb,
  patterns jsonb not null default '[]'::jsonb,
  summary_memory text not null default '',
  onboarding_completed_at timestamptz,
  notification_prefs jsonb not null default '{"enabled": true, "frequency": "daily"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are owned by the user" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Automatically create a blank profile row when a new auth user signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', null));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------
-- journal_entries — Full Journal mode (PRD 5.4)
-- ---------------------------------------------------------------------
create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null default 'full' check (mode in ('full', 'snap')),
  content text not null,
  ai_reflection text,
  mood_tags jsonb not null default '[]'::jsonb,
  energy_level smallint check (energy_level between 1 and 5),
  themes jsonb not null default '[]'::jsonb,
  linked_goal_ids uuid[] not null default '{}',
  source text not null default 'manual' check (source in ('chat', 'manual', 'apple_journal_import')),
  entry_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index journal_entries_user_id_idx on public.journal_entries (user_id, entry_date desc);

alter table public.journal_entries enable row level security;

create policy "journal entries are owned by the user" on public.journal_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- snaps — Snap Mode quick entries (PRD 5.4)
-- ---------------------------------------------------------------------
create table public.snaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  mood_tags jsonb not null default '[]'::jsonb,
  energy_level smallint check (energy_level between 1 and 5),
  themes jsonb not null default '[]'::jsonb,
  linked_goal_id uuid,
  created_at timestamptz not null default now()
);

create index snaps_user_id_idx on public.snaps (user_id, created_at desc);

alter table public.snaps enable row level security;

create policy "snaps are owned by the user" on public.snaps
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- goals — Big Life Goals, Increments, Bucket List (PRD 5.5)
-- ---------------------------------------------------------------------
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('big_goal', 'increment', 'bucket_list')),
  parent_goal_id uuid references public.goals (id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'completed', 'archived')),
  target_age integer,
  target_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index goals_user_id_idx on public.goals (user_id, type);
create index goals_parent_goal_id_idx on public.goals (parent_goal_id);

alter table public.goals enable row level security;

create policy "goals are owned by the user" on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Add the deferred FK from snaps -> goals now that goals exists.
alter table public.snaps
  add constraint snaps_linked_goal_id_fkey
  foreign key (linked_goal_id) references public.goals (id) on delete set null;

-- ---------------------------------------------------------------------
-- suggestions — Suggestions page (PRD 5.6)
-- ---------------------------------------------------------------------
create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null check (
    category in ('book', 'music', 'habit', 'experience', 'food', 'journal_prompt')
  ),
  title text not null,
  description text,
  status text not null default 'pending' check (status in ('pending', 'done', 'saved', 'not_for_me')),
  cycle_period text not null default 'weekly' check (cycle_period in ('weekly', 'monthly')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index suggestions_user_id_idx on public.suggestions (user_id, status);

alter table public.suggestions enable row level security;

create policy "suggestions are owned by the user" on public.suggestions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- calendar_events — Google Calendar sync (PRD 6.2)
-- ---------------------------------------------------------------------
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  google_event_id text,
  title text not null,
  description text,
  start_time timestamptz not null,
  end_time timestamptz,
  source text not null default 'chat' check (source in ('chat', 'manual', 'google_sync')),
  created_at timestamptz not null default now()
);

create index calendar_events_user_id_idx on public.calendar_events (user_id, start_time);
create unique index calendar_events_google_event_id_idx
  on public.calendar_events (user_id, google_event_id)
  where google_event_id is not null;

alter table public.calendar_events enable row level security;

create policy "calendar events are owned by the user" on public.calendar_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- strava_data — Strava activity sync (PRD 6.1)
-- ---------------------------------------------------------------------
create table public.strava_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  strava_activity_id bigint not null,
  activity_type text,
  distance_meters numeric,
  duration_seconds integer,
  average_pace numeric,
  average_heart_rate numeric,
  started_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index strava_data_user_activity_idx
  on public.strava_data (user_id, strava_activity_id);

alter table public.strava_data enable row level security;

create policy "strava data is owned by the user" on public.strava_data
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- chat_history — Main chat interface (PRD 5.3)
-- ---------------------------------------------------------------------
create table public.chat_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index chat_history_user_id_idx on public.chat_history (user_id, created_at);

alter table public.chat_history enable row level security;

create policy "chat history is owned by the user" on public.chat_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- memory_summaries — rolling compressed memory (PRD 7.2)
-- ---------------------------------------------------------------------
create table public.memory_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create index memory_summaries_user_id_idx on public.memory_summaries (user_id, period_end desc);

alter table public.memory_summaries enable row level security;

create policy "memory summaries are owned by the user" on public.memory_summaries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();

create trigger set_updated_at before update on public.journal_entries
  for each row execute procedure public.set_updated_at();

create trigger set_updated_at before update on public.goals
  for each row execute procedure public.set_updated_at();
