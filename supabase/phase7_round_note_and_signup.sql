-- =====================================================================
-- Phase 7 migration: 3-way round note + real names on signup.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.
-- =====================================================================

-- ---------- Round note (optional 3-way annotation on a score) ----------
-- Widens the old 2-way margin_tag (close / decisive) into an optional
-- decisive / moderate / close note. margin_tag stays in the table but is
-- no longer written or read by the app; round_note is backfilled from it.
alter table public.scores
  add column if not exists round_note text;

do $$ begin
  alter table public.scores
    add constraint scores_round_note_chk
    check (round_note is null or round_note in ('decisive', 'moderate', 'close'));
exception when duplicate_object then null; end $$;

-- Backfill from the old margin_tag. Some scores are locked, and the
-- immutability trigger (trg_lock_scores) blocks edits to a locked row, so
-- disable it for this one controlled migration update, exactly as
-- lock_round() and complete_fight() do for their bulk locks.
alter table public.scores disable trigger trg_lock_scores;
update public.scores
   set round_note = margin_tag
 where round_note is null and margin_tag is not null;
alter table public.scores enable trigger trg_lock_scores;


-- ---------- Real names + email on profiles ----------
alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name  text,
  add column if not exists email      text;

-- Recompose the signup handler: capture first/last name (passed via
-- auth.signUp options.data) and the email, and build full_name from them.
-- Falls back to full_name meta (older clients), then the email.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_first text := nullif(trim(new.raw_user_meta_data->>'first_name'), '');
  v_last  text := nullif(trim(new.raw_user_meta_data->>'last_name'), '');
  v_full  text := nullif(trim(concat_ws(' ', v_first, v_last)), '');
begin
  insert into public.profiles (id, first_name, last_name, email, full_name, role, status)
  values (
    new.id,
    v_first,
    v_last,
    new.email,
    coalesce(v_full, nullif(new.raw_user_meta_data->>'full_name', ''), new.email),
    'judge',      -- default lowest privilege; admins elevate after review
    'pending'     -- must be approved before scoring
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- Backfill email onto existing profiles from the auth record.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id and p.email is null;
