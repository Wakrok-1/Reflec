-- Conversation Engine v1.6, revised: api/chat.ts generates one main-model
-- response per turn (not three ranked candidates — see the removed
-- response_candidates table this replaces) and runs it through a
-- string-based therapy-speak filter. This table logs the outcome — the
-- response actually sent, its therapy-speak score, and whether it took a
-- regeneration to get there — as a lightweight preference signal for a
-- future fine-tuning dataset. Self-contained (no FK to chat_history): a
-- fine-tuning export reads straight off this one table.
create table public.response_quality_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  response_text text not null,
  therapy_speak_score integer not null default 0,
  regenerated boolean not null default false,
  created_at timestamptz not null default now()
);

create index response_quality_log_user_id_idx on public.response_quality_log (user_id, created_at desc);

alter table public.response_quality_log enable row level security;

-- Same ownership shape as every other user-scoped table (README "Security
-- notes") — api/chat.ts writes this via the caller's own RLS-scoped
-- client, never the service-role client.
create policy "response quality log is owned by the user" on public.response_quality_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
