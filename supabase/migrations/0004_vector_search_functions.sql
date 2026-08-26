-- Vector similarity search RPCs for chat context building (PRD 7.2
-- "Vector Search"). PostgREST's query builder has no way to ORDER BY a
-- `<=>` expression, so semantic search has to go through an RPC function
-- instead of a plain `.select()`.
--
-- Both functions default to SECURITY INVOKER (Postgres default — not
-- overridden here), so they run as the calling role and stay subject to
-- each table's row-level security; the explicit `user_id = match_user_id`
-- filter below is for query efficiency, RLS is still the real boundary.

create or replace function public.match_journal_entries(
  query_embedding vector(384),
  match_user_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  content text,
  created_at timestamptz,
  similarity real
)
language sql stable
as $$
  select
    journal_entries.id,
    journal_entries.content,
    journal_entries.created_at,
    1 - (journal_entries.embedding <=> query_embedding) as similarity
  from public.journal_entries
  where journal_entries.user_id = match_user_id
    and journal_entries.embedding is not null
  order by journal_entries.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_chat_history(
  query_embedding vector(384),
  match_user_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  content text,
  created_at timestamptz,
  similarity real
)
language sql stable
as $$
  select
    chat_history.id,
    chat_history.content,
    chat_history.created_at,
    1 - (chat_history.embedding <=> query_embedding) as similarity
  from public.chat_history
  where chat_history.user_id = match_user_id
    and chat_history.embedding is not null
  order by chat_history.embedding <=> query_embedding
  limit match_count;
$$;
