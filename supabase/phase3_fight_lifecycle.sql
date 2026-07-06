-- =====================================================================
-- Phase 3 migration: fight lifecycle closure (result + completed/cancelled).
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.
-- Existing RLS already covers these columns ("fights: officials write"),
-- so no new policies are needed.
-- =====================================================================

-- ---- Result fields, recorded when an official closes the bout ----
alter table public.fights
  add column if not exists result_method text,       -- decision | ko | tko | submission | dq | no_contest
  add column if not exists result_winner  text,       -- a | b | draw (null for no_contest)
  add column if not exists result_round   int,        -- round the finish occurred in (null for decision)
  add column if not exists result_note    text,
  add column if not exists completed_at   timestamptz;

do $$ begin
  alter table public.fights
    add constraint fights_result_method_chk
    check (result_method is null or result_method in ('decision','ko','tko','submission','dq','no_contest'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.fights
    add constraint fights_result_winner_chk
    check (result_winner is null or result_winner in ('a','b','draw'));
exception when duplicate_object then null; end $$;

-- A bout cannot be marked completed without a recorded result.
do $$ begin
  alter table public.fights
    add constraint fights_completed_has_result_chk
    check (state <> 'completed' or result_method is not null);
exception when duplicate_object then null; end $$;

-- =====================================================================
-- CLOSING A BOUT — official calls this once; it locks every remaining
-- round (so no further scoring is possible) and stamps the result.
-- Mirrors lock_round()'s pattern of disabling the immutability trigger
-- only for the controlled bulk-lock it performs itself.
-- =====================================================================
create or replace function public.complete_fight(
  f_id uuid, method text, winner text, at_round int, note text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_state fight_state;
begin
  if not public.is_official() then
    raise exception 'Only officials may close a bout.' using errcode = '42501';
  end if;

  select state into v_state from public.fights where id = f_id;
  if v_state is null then
    raise exception 'Fight not found.';
  end if;
  if v_state = 'completed' then
    raise exception 'Bout is already completed.' using errcode = 'check_violation';
  end if;

  alter table public.scores disable trigger trg_lock_scores;
  update public.rounds
     set state = 'locked', locked_at = now()
   where fight_id = f_id and state <> 'locked';
  update public.scores
     set is_locked = true, updated_at = now()
   where fight_id = f_id and is_locked = false;
  alter table public.scores enable trigger trg_lock_scores;

  update public.fights
     set state         = 'completed',
         result_method = method,
         result_winner = winner,
         result_round  = at_round,
         result_note   = note,
         completed_at  = now()
   where id = f_id;
end $$;
