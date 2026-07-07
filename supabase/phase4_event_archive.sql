-- Phase 4: event archiving.
-- Run once in the Supabase SQL editor (idempotent). Archived events keep all
-- their data and stay searchable in FightTrack, but drop out of the main
-- events list. No RLS change: the existing officials-write policy covers
-- setting and clearing archived_at.

alter table public.events
  add column if not exists archived_at timestamptz;

comment on column public.events.archived_at is
  'Set when an official archives a finished event; null = active.';

create index if not exists idx_events_archived on public.events (archived_at)
  where archived_at is not null;
