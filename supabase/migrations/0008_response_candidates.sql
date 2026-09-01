-- Conversation Engine v1.6 upgrade: api/chat.ts now generates 3 candidate
-- replies per turn (same model, different temperatures), has a fast
-- ranker call pick a winner, and runs that winner through a therapy-speak
-- filter before it's sent. This table stores all 3 candidates plus what
-- was actually chosen and why, for offline review of ranker quality —
-- it's write-only from the app's perspective, never read back into a
-- live response.
create table public.response_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.chat_history (id) on delete cascade,
  candidate_a text not null,
  candidate_b text not null,
  candidate_c text not null,
  -- 'A' | 'B' | 'C' (the ranker's pick, or a later candidate if the
  -- therapy-speak filter passed over the winner), or 'REGENERATED' when
  -- all three scored too high on the filter and a fresh reply replaced
  -- them — that fourth reply isn't one of a/b/c, so there's no letter for it.
  winner text not null check (winner in ('A', 'B', 'C', 'REGENERATED')),
  ranker_reason text,
  created_at timestamptz not null default now()
);

create index response_candidates_user_id_idx on public.response_candidates (user_id, created_at desc);
create index response_candidates_message_id_idx on public.response_candidates (message_id);

alter table public.response_candidates enable row level security;

-- Same ownership shape as every other user-scoped table (README "Security
-- notes") — api/chat.ts writes this via the caller's own RLS-scoped
-- client, never the service-role client, so this policy is the only thing
-- standing between one user's candidates and another's.
create policy "response candidates are owned by the user" on public.response_candidates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
