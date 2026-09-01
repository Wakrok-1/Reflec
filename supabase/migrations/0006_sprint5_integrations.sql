-- Sprint 5 — Integrations: Google Calendar + Web Push notifications.
-- Strava is explicitly out of scope for this sprint (per Sprint 5 scope
-- decision) — strava_data stays as the untouched Sprint 0 foundation
-- table, and no Strava code, sync, or context injection is added.

-- ---------------------------------------------------------------------
-- google_calendar_connections — one row per user holding their OAuth
-- tokens (PRD 6.2). Deliberately its own table rather than columns on
-- calendar_events: calendar_events is one row per *event* (already used
-- for chat-written/manually-added events), so storing a connection's
-- tokens there would duplicate them across every event row and make
-- refresh-on-expiry a multi-row update instead of a single one.
-- ---------------------------------------------------------------------
create table public.google_calendar_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scope text,
  calendar_id text not null default 'primary',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_calendar_connections enable row level security;

create policy "google calendar connections are owned by the user" on public.google_calendar_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger set_updated_at before update on public.google_calendar_connections
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------
-- oauth_states — short-lived, single-use CSRF/identity-linking tokens
-- for the OAuth authorization-code redirect round trip. Google's
-- callback request carries no Supabase session (it's a plain browser
-- redirect from Google's server, no bearer token) — this table is how
-- api/auth.ts's Google callback path recovers *which* user just authorized, without
-- trusting anything the redirect itself claims beyond possession of the
-- exact opaque `state` value this app minted and handed to Google.
-- ---------------------------------------------------------------------
create table public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google')),
  created_at timestamptz not null default now()
);

alter table public.oauth_states enable row level security;

-- Row-owner can insert/read their own pending state (api/auth.ts's
-- google-start action runs as the authenticated user). The callback itself has no user JWT at
-- all, so it reads/deletes via the service-role client — the one other
-- narrow exception in this app besides the notification cron, both
-- documented in api/_lib/supabaseAdmin.ts.
create policy "oauth states are owned by the user" on public.oauth_states
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- notification_log — dedup ledger so the daily cron never double-sends
-- the same check-in or goal reminder if it runs more than once, and so
-- "goal reminder" can be deduped per-goal rather than per-user.
-- ---------------------------------------------------------------------
create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('daily_checkin', 'goal_reminder', 'suggestion_ready')),
  ref_id text,
  sent_at timestamptz not null default now()
);

create index notification_log_user_type_idx on public.notification_log (user_id, type, sent_at);

alter table public.notification_log enable row level security;

create policy "notification log is owned by the user" on public.notification_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- profiles — push subscription + richer notification preferences.
-- notification_prefs already existed (Sprint 0 foundation column,
-- '{"enabled": true, "frequency": "daily"}') but nothing consumed it
-- yet; Sprint 5 is the first feature to actually read/write it, so its
-- shape is widened here to the one the Notifications settings UI and
-- the daily cron both need:
--   {
--     "daily_checkin": boolean,
--     "goal_reminders": boolean,
--     "suggestions": boolean,
--     "quiet_hours_start": "HH:MM" | null,
--     "quiet_hours_end": "HH:MM" | null
--   }
-- Existing rows keep their old shape until the app writes a new one
-- (the settings UI always writes the full new shape on first save), so
-- no backfill/rewrite of existing rows is needed — jsonb tolerates both
-- shapes existing until then, and every reader treats missing keys as
-- "off"/"unset" rather than throwing.
-- ---------------------------------------------------------------------
alter table public.profiles
  add column push_subscription jsonb;

comment on column public.profiles.push_subscription is
  'Web Push PushSubscription.toJSON() — endpoint + keys, not a secret credential (no service-role access needed to read/write it; RLS is enough).';
