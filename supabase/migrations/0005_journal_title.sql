-- Full Journal mode gets an optional title field (PRD "Sprint 3 — Full
-- Journal + PDF Export", item 1). journal_entries had no such column.
alter table public.journal_entries add column title text;
