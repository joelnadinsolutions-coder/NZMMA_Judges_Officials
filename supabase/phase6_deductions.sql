-- =====================================================================
-- Phase 6 migration: point deductions as a central, auditable record.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.
--
-- Replaces the old per-round official-only columns
-- (rounds.fighter_a_deduction / _b / deduction_note), which stay in the
-- table but are no longer written or read by the app. A deduction is now a
-- first-class row: entered by an assigned judge OR an official, carries its
-- author, has a pending -> confirmed | voided lifecycle, is fully audited,
-- and is broadcast over Realtime. Totals subtract every non-voided
-- deduction the moment it is entered, regardless of status.
-- =====================================================================

-- ---------- Enums ----------
do $$ begin
  create type deduction_corner as enum ('red', 'blue');
exception when duplicate_object then null; end $$;

do $$ begin
  create type deduction_status as enum ('pending', 'confirmed', 'voided');
exception when duplicate_object then null; end $$;


-- =====================================================================
-- DEDUCTIONS  — one row per point deduction, tied to a real round.
-- corner is red/blue; the app maps it to fighter A/B via the fight's
-- fighter_a_corner / fighter_b_corner when subtracting.
-- =====================================================================
create table if not exists public.deductions (
  id            uuid primary key default gen_random_uuid(),
  fight_id      uuid not null references public.fights(id) on delete cascade,
  round_number  int  not null,
  corner        deduction_corner not null,
  points        int  not null default 1 check (points between 1 and 3),
  reason        text,
  entered_by    uuid not null references public.profiles(id) on delete cascade,
  status        deduction_status not null default 'pending',
  confirmed_by  uuid references public.profiles(id) on delete set null,  -- who confirmed OR voided
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  -- Composite FK ties every deduction to a real round of that fight
  -- (rounds are pre-seeded 1..N at bout creation), mirroring scores.
  constraint deductions_round_fk foreign key (fight_id, round_number)
    references public.rounds (fight_id, round_number) on delete cascade
);
create index if not exists idx_deductions_fight       on public.deductions (fight_id);
create index if not exists idx_deductions_fight_round on public.deductions (fight_id, round_number);

comment on table public.deductions is
  'Central point-deduction record. Entered by an assigned judge or an official; pending -> confirmed | voided via set_deduction_status() only.';


-- =====================================================================
-- DEDUCTION_AUDIT  — immutable trail of every insert and status change.
-- Mirrors score_audit. Populated by the insert trigger and the RPC.
-- =====================================================================
create table if not exists public.deduction_audit (
  id            bigint generated always as identity primary key,
  deduction_id  uuid,
  fight_id      uuid,
  round_number  int,
  action        text,             -- INSERT / CONFIRM / VOID
  actor         uuid,             -- who did it (auth.uid())
  old_status    deduction_status,
  new_status    deduction_status,
  snapshot      jsonb,
  changed_at    timestamptz not null default now()
);
create index if not exists idx_deduction_audit_fight on public.deduction_audit (fight_id, round_number);

-- Log every insert (author = entered_by).
create or replace function public.audit_deduction_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.deduction_audit(
    deduction_id, fight_id, round_number, action, actor, old_status, new_status, snapshot)
  values (new.id, new.fight_id, new.round_number, 'INSERT', new.entered_by,
          null, new.status, to_jsonb(new));
  return new;
end $$;

drop trigger if exists trg_audit_deduction_insert on public.deductions;
create trigger trg_audit_deduction_insert
  after insert on public.deductions
  for each row execute function public.audit_deduction_insert();


-- =====================================================================
-- GUARD  — core fields are immutable; status only moves
-- pending -> confirmed | voided. Fires for every UPDATE, including the
-- SECURITY DEFINER RPC below (defence in depth). No caller can rewrite a
-- deduction's substance or re-open a settled one.
-- =====================================================================
create or replace function public.guard_deduction_update()
returns trigger language plpgsql as $$
begin
  if old.status <> 'pending' then
    raise exception 'Deduction % is already % and cannot change.', old.id, old.status
      using errcode = 'check_violation';
  end if;
  if new.status not in ('confirmed', 'voided') then
    raise exception 'A deduction can only move to confirmed or voided.'
      using errcode = 'check_violation';
  end if;
  if new.fight_id     is distinct from old.fight_id
     or new.round_number is distinct from old.round_number
     or new.corner     is distinct from old.corner
     or new.points     is distinct from old.points
     or new.reason     is distinct from old.reason
     or new.entered_by is distinct from old.entered_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Deduction core fields are immutable.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_deduction on public.deductions;
create trigger trg_guard_deduction
  before update on public.deductions
  for each row execute function public.guard_deduction_update();


-- =====================================================================
-- STATUS TRANSITION RPC  — the only supported way to confirm or void.
--   * officials/admins may confirm or void at any time.
--   * the author (entered_by) may VOID their own, but only within 60
--     seconds of created_at (server clock, never client-supplied).
-- Every transition is audited with who and when.
-- =====================================================================
create or replace function public.set_deduction_status(d_id uuid, new_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  d      public.deductions;
  target deduction_status;
begin
  if new_status not in ('confirmed', 'voided') then
    raise exception 'Invalid target status: %', new_status using errcode = 'check_violation';
  end if;
  target := new_status::deduction_status;

  select * into d from public.deductions where id = d_id for update;
  if not found then
    raise exception 'Deduction not found.' using errcode = 'check_violation';
  end if;
  if d.status <> 'pending' then
    raise exception 'Deduction is already %.', d.status using errcode = 'check_violation';
  end if;

  if public.is_official() then
    null;  -- officials/admins may confirm or void at any time
  elsif d.entered_by = auth.uid() then
    if target <> 'voided' then
      raise exception 'You can only void your own deduction.' using errcode = '42501';
    end if;
    if now() - d.created_at > interval '60 seconds' then
      raise exception 'The 60 second undo window has passed. Contact the head official to amend.'
        using errcode = '42501';
    end if;
  else
    raise exception 'Not authorised to change this deduction.' using errcode = '42501';
  end if;

  update public.deductions
     set status       = target,
         confirmed_by = auth.uid(),
         confirmed_at = now()
   where id = d_id;

  insert into public.deduction_audit(
    deduction_id, fight_id, round_number, action, actor, old_status, new_status, snapshot)
  values (d.id, d.fight_id, d.round_number,
          case when target = 'confirmed' then 'CONFIRM' else 'VOID' end,
          auth.uid(), d.status, target,
          to_jsonb((select x from public.deductions x where x.id = d_id)));
end $$;


-- =====================================================================
-- ROW-LEVEL SECURITY
-- Insert + select: any judge assigned to the fight, or any official/admin.
-- No UPDATE or DELETE policy exists: transitions go only through
-- set_deduction_status() (SECURITY DEFINER), and deductions are never deleted.
-- =====================================================================
alter table public.deductions      enable row level security;
alter table public.deduction_audit enable row level security;

drop policy if exists "ded: read assigned or official" on public.deductions;
create policy "ded: read assigned or official"
  on public.deductions for select
  using (public.is_assigned_judge(fight_id) or public.is_official());

drop policy if exists "ded: insert assigned or official" on public.deductions;
create policy "ded: insert assigned or official"
  on public.deductions for insert
  with check (
    entered_by = auth.uid()
    and (public.is_assigned_judge(fight_id) or public.is_official())
  );

drop policy if exists "ded audit: officials read" on public.deduction_audit;
create policy "ded audit: officials read"
  on public.deduction_audit for select
  using (public.is_official());
-- inserts happen via SECURITY DEFINER trigger / RPC only; no user insert policy.


-- =====================================================================
-- REALTIME  — live deductions on every judge card and the control page.
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.deductions;
exception when duplicate_object then null; end $$;
