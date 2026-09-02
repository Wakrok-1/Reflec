-- Self-Concept Layer (PRD v1.6 Part 2). One row per user, updated by the
-- extract-patterns Edge Function's third pass after every chat turn:
--   - declared_self: explicit self-declarations ("I am...", "I've always
--     been...") in the user's own words — the highest-authority source
--     (see systemPrompt.ts's SELF-CONCEPT PRIORITY).
--   - observed_self: behavioural inferences the model made, each with
--     its own per-pattern confidence.
--   - identity_tensions: short phrases naming a contradiction between two
--     parts of how they see/present themselves.
--   - identity_evolution: a running, month-keyed log of how their
--     dominant self-concept has shifted over time.
--   - confidence_scores: how much evidence exists across six broad
--     dimensions (0-1 each), replacing the old single on/off
--     personality_emergence_unlocked gate with something graduated.
--   - interaction_memory: what has and hasn't worked when talking to
--     this specific person — felt-right response styles, rejected
--     interpretations, topics that open them up vs. shut them down.
-- user_id (not a separate id column) is the primary key, matching
-- pattern_extractions — one row per user, and it's what api/chat.ts and
-- extract-patterns's .upsert() calls need to be the conflict target by
-- default (supabase-js upserts on the primary key unless told otherwise).
create table public.self_concept (
  user_id uuid primary key references auth.users (id) on delete cascade,
  declared_self jsonb not null default '{}'::jsonb,
  observed_self jsonb not null default '{"patterns": []}'::jsonb,
  identity_tensions jsonb not null default '[]'::jsonb,
  identity_evolution jsonb not null default '[]'::jsonb,
  confidence_scores jsonb not null default '{
    "surface": 0,
    "values": 0,
    "behaviour": 0,
    "emotional_patterns": 0,
    "self_concept": 0,
    "deep_identity": 0
  }'::jsonb,
  interaction_memory jsonb not null default '{
    "callbacks_worked": [],
    "interpretations_rejected": [],
    "topics_that_expand": [],
    "topics_that_close": [],
    "humour_landed": [],
    "response_styles_preferred": []
  }'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.self_concept enable row level security;

-- Same ownership shape as every other user-scoped table (README "Security
-- notes") — extract-patterns writes this via the caller's own RLS-scoped
-- client, never the service-role client.
create policy "self concept is owned by the user" on public.self_concept
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- personality_emergence_unlocked (0002_v1_3_memory_upgrade.sql) is
-- replaced by self_concept.confidence_scores — a graduated per-dimension
-- model instead of one global boolean gate.
alter table public.profiles drop column if exists personality_emergence_unlocked;
