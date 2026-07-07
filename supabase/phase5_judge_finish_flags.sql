-- Phase 5: judge finish flags.
-- Run once in the Supabase SQL editor (idempotent).
--
-- A judge who sees the fight end early (KO, TKO, submission, DQ) records it
-- on their own card: the flag closes THEIR scorecard only and shows on the
-- official's control page. It carries no authority: only the official's
-- complete_fight() closes the bout, and the official's recorded result
-- always overrules whatever judges flagged.

create table if not exists public.judge_finish_flags (
  id           uuid primary key default gen_random_uuid(),
  fight_id     uuid not null references public.fights(id) on delete cascade,
  judge_id     uuid not null references public.profiles(id) on delete cascade,
  round_number int  not null check (round_number >= 1),
  method       text not null check (method in ('ko', 'tko', 'submission', 'dq', 'other')),
  note         text,
  created_at   timestamptz not null default now(),
  unique (fight_id, judge_id)
);

comment on table public.judge_finish_flags is
  'A judge''s own observation that the fight finished early. Informational only; the official''s result is authoritative.';

alter table public.judge_finish_flags enable row level security;

-- A judge manages only their own flag, and only on bouts they are assigned
-- to. "for all" includes delete, so a mistaken flag can be undone.
drop policy if exists "flags: judge manages own" on public.judge_finish_flags;
create policy "flags: judge manages own"
  on public.judge_finish_flags for all
  using (judge_id = auth.uid() and public.is_assigned_judge(fight_id))
  with check (judge_id = auth.uid() and public.is_assigned_judge(fight_id));

drop policy if exists "flags: officials read" on public.judge_finish_flags;
create policy "flags: officials read"
  on public.judge_finish_flags for select
  using (public.is_official());

-- Live updates on the control page.
do $$ begin
  alter publication supabase_realtime add table public.judge_finish_flags;
exception when duplicate_object then null; end $$;
