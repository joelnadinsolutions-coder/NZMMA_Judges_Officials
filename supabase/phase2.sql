-- =====================================================================
-- Phase 2 migration: point deductions + round formats.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.
-- Existing RLS already covers these columns:
--   - officials can UPDATE rounds/fights (deductions, state, format)
--   - assigned judges can READ rounds/fights (see the deductions + format)
-- so no new policies are needed.
-- =====================================================================

-- ---- Point deductions: per round, per fighter (a referee action) ----
-- Kept on the round (not on a judge's card), so a deduction applies to every
-- judge's tally uniformly. Final total = base 10-point-must score - deduction.
alter table public.rounds
  add column if not exists fighter_a_deduction int  not null default 0,
  add column if not exists fighter_b_deduction int  not null default 0,
  add column if not exists deduction_note      text;

do $$ begin
  alter table public.rounds
    add constraint rounds_deduction_a_chk check (fighter_a_deduction between 0 and 3);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.rounds
    add constraint rounds_deduction_b_chk check (fighter_b_deduction between 0 and 3);
exception when duplicate_object then null; end $$;

-- ---- Round formats: 3x3, 3x5, 5x5 (championship) ----
-- scheduled_rounds (3 or 5) already exists; add round length + a title flag.
alter table public.fights
  add column if not exists round_minutes   int     not null default 5,
  add column if not exists is_championship boolean not null default false;

do $$ begin
  alter table public.fights
    add constraint fights_round_minutes_chk check (round_minutes in (3, 5));
exception when duplicate_object then null; end $$;
