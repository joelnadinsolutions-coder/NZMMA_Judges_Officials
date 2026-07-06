-- =====================================================================
-- Phase 2b: optional per-score margin tag (close / decisive).
-- A judge's optional annotation of how the round was won, alongside the
-- free-text note. Idempotent; run in the Supabase SQL editor.
-- Covered by existing RLS (it is just another column on scores).
-- =====================================================================
alter table public.scores
  add column if not exists margin_tag text;

do $$ begin
  alter table public.scores
    add constraint scores_margin_tag_chk
    check (margin_tag is null or margin_tag in ('close', 'decisive'));
exception when duplicate_object then null; end $$;
