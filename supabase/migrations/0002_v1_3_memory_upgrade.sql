-- Your Reflection — v1.3 upgrade: RAG memory layer + latent personality model
--
-- Adds pgvector/pg_cron, embedding columns + HNSW indexes, and the four new
-- tables Sprint 1 depends on (pattern_extractions, dismissed_suggestions,
-- taste_profile, response_signals). See PRD v1.3 section 7.2 and section 8
-- Sprint 0 "Key schema notes".
--
-- Embedding dimension: gte-small (Supabase's built-in embedding model,
-- PRD section 4) produces 384-dimension vectors. The PRD's section 8 schema
-- note mentioning vector(1536) is a leftover from an OpenAI-embeddings draft
-- and is superseded here by the explicit gte-small tech choice.

create extension if not exists "vector";

-- pg_cron can only be enabled by a project owner from the Supabase
-- dashboard (Database -> Extensions) on some project tiers, and isn't
-- installed at all on a plain local Postgres. Attempt it so the migration
-- is a no-op if it's already on, but never fail the whole migration over
-- it — catch broadly (missing extension file, insufficient privilege,
-- anything else) since the rest of this migration doesn't depend on it.
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception when others then
  raise notice 'pg_cron could not be created automatically (%) — enable it from the Supabase dashboard under Database > Extensions.', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------
-- profiles: personality emergence gate, drop favourites (superseded by
-- the dedicated taste_profile table below)
-- ---------------------------------------------------------------------
alter table public.profiles
  add column personality_emergence_unlocked boolean not null default false;

alter table public.profiles
  drop column favourites;

-- ---------------------------------------------------------------------
-- embeddings on journal_entries / snaps (per-entry), memory_summaries
-- (summary rows only), and chat_history (summary rows only — PRD section
-- 8 Sprint 0 note: "chat_history includes embedding on summary rows only")
-- ---------------------------------------------------------------------
alter table public.journal_entries add column embedding vector(384);
alter table public.snaps add column embedding vector(384);
alter table public.memory_summaries add column embedding vector(384);
alter table public.chat_history add column embedding vector(384);

-- memory_summaries gains a tier column: daily | weekly | monthly, plus
-- "onboarding" for the one-off summary generated at the end of Sprint 1's
-- AI interview (PRD section 8, Sprint 1 bullet list).
alter table public.memory_summaries
  add column tier text not null default 'daily'
    check (tier in ('onboarding', 'daily', 'weekly', 'monthly'));

create index journal_entries_embedding_idx on public.journal_entries
  using hnsw (embedding vector_cosine_ops);
create index snaps_embedding_idx on public.snaps
  using hnsw (embedding vector_cosine_ops);
create index memory_summaries_embedding_idx on public.memory_summaries
  using hnsw (embedding vector_cosine_ops);
create index chat_history_embedding_idx on public.chat_history
  using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------
-- taste_profile — surface + middle layer taste data with emotional
-- context per item (PRD 5.2 Taste Profile, 7.2 Latent Personality Model)
-- ---------------------------------------------------------------------
create table public.taste_profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null check (
    category in ('music', 'books', 'sport', 'food', 'aesthetics', 'hobbies', 'symbols')
  ),
  item text not null,
  context text,
  source text not null default 'chat' check (source in ('onboarding', 'chat', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index taste_profile_user_id_idx on public.taste_profile (user_id, category);

alter table public.taste_profile enable row level security;

create policy "taste profile is owned by the user" on public.taste_profile
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger set_updated_at before update on public.taste_profile
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------
-- pattern_extractions — one row per user, the full structured JSON model
-- (emotional, taste context, writing signature, response preference)
-- updated async after every entry (PRD 7.2 Structured Pattern Extraction)
-- ---------------------------------------------------------------------
create table public.pattern_extractions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  emotional_triggers jsonb not null default '[]'::jsonb,
  coping_patterns jsonb not null default '[]'::jsonb,
  energy_patterns jsonb not null default '[]'::jsonb,
  communication_style text,
  recurring_themes jsonb not null default '[]'::jsonb,
  taste_context jsonb not null default '{}'::jsonb,
  writing_signature jsonb not null default '{}'::jsonb,
  response_preference jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.pattern_extractions enable row level security;

create policy "pattern extractions are owned by the user" on public.pattern_extractions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger set_updated_at before update on public.pattern_extractions
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------
-- dismissed_suggestions — any AI suggestion bubble (profile trait, taste
-- entry, growth-page nudge) the user dismissed. Never resurfaced.
-- ---------------------------------------------------------------------
create table public.dismissed_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  suggestion_type text not null check (
    suggestion_type in ('profile_field', 'taste_entry', 'growth_insight')
  ),
  -- A stable fingerprint of the suggestion's content (e.g. a hash or the
  -- normalized field+value), so the same suggestion is recognized again
  -- even if it's regenerated by a later extraction pass.
  fingerprint text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index dismissed_suggestions_user_fingerprint_idx
  on public.dismissed_suggestions (user_id, suggestion_type, fingerprint);

alter table public.dismissed_suggestions enable row level security;

create policy "dismissed suggestions are owned by the user" on public.dismissed_suggestions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- response_signals — per-message "felt right" taps (PRD 5.3, 7.2)
-- Empty until Sprint 2 wires up the chat feedback affordance; the table
-- exists now so pattern extraction can read from it from day one.
-- ---------------------------------------------------------------------
create table public.response_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_message_id uuid references public.chat_history (id) on delete cascade,
  felt_right boolean not null default true,
  created_at timestamptz not null default now()
);

create index response_signals_user_id_idx on public.response_signals (user_id, created_at desc);

alter table public.response_signals enable row level security;

create policy "response signals are owned by the user" on public.response_signals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
