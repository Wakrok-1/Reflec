-- Your Reflection — v1.5 upgrade: typed memory entities + private entries
--
-- PRD v1.5 section 7.2 "Typed Memory Entities" and section 8 Sprint 0
-- "New in v1.5". Structured long-term memory beyond plain semantic
-- search: every meaningful fact extracted from journal entries, snaps,
-- and conversations is stored as a typed, confidence-scored memory that
-- can be filtered by type/date before the HNSW vector search runs
-- (hybrid retrieval).
--
-- Embedding dimension: 384, matching gte-small (see 0002's note — the
-- PRD's vector(1536) mentions are leftover from an OpenAI-embeddings
-- draft and are superseded by the explicit gte-small tech choice).

-- ---------------------------------------------------------------------
-- memories — typed memory entities (PRD 7.2)
-- ---------------------------------------------------------------------
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (
    type in ('EVENT', 'BELIEF', 'GOAL', 'PREFERENCE', 'EMOTION', 'HABIT', 'ACHIEVEMENT', 'PROBLEM')
  ),
  content text not null,
  confidence real not null default 0.5 check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  related_entries uuid[] not null default '{}',
  embedding vector(384)
);

-- B-tree indexes for the metadata-filter half of hybrid retrieval (PRD
-- 7.2 "Hybrid Retrieval") — these narrow the row set before the HNSW
-- index does semantic ranking on what's left.
create index memories_user_id_idx on public.memories (user_id);
create index memories_type_idx on public.memories (type);

create index memories_embedding_idx on public.memories
  using hnsw (embedding vector_cosine_ops);

alter table public.memories enable row level security;

create policy "memories are owned by the user" on public.memories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- private_entries — junction table flagging journal_entries/snaps the
-- user has marked private. Excluded from all memory extraction and
-- pattern analysis jobs (PRD 8, "New in v1.5").
--
-- entry_id intentionally has no foreign key: it points into either
-- journal_entries or snaps depending on entry_type, and Postgres has no
-- conditional FK. Extraction/analysis jobs must anti-join against this
-- table on (entry_id, entry_type) before processing a row.
-- ---------------------------------------------------------------------
create table public.private_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  entry_id uuid not null,
  entry_type text not null check (entry_type in ('journal', 'snap')),
  created_at timestamptz not null default now()
);

create unique index private_entries_entry_idx on public.private_entries (entry_id, entry_type);
create index private_entries_user_id_idx on public.private_entries (user_id);

alter table public.private_entries enable row level security;

create policy "private entry flags are owned by the user" on public.private_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- profiles.personality_emergence_unlocked already exists (added in
-- 0002_v1_3_memory_upgrade.sql). Nothing to do here — left as a comment
-- so this migration file documents that the PRD's "if not already there"
-- check was made.
-- ---------------------------------------------------------------------
