-- =====================================================================
-- NZMMAF FightTrack / Roundmaster — Supabase (Postgres) schema
-- Run in the Supabase SQL editor, or via `supabase db push`.
-- Idempotent-ish: safe enough for a fresh project. Review before prod.
-- =====================================================================

-- ---------- Extensions ----------
create extension if not exists pgcrypto;      -- gen_random_uuid()

-- ---------- Enums ----------
do $$ begin
  create type user_role     as enum ('admin', 'official', 'judge');
exception when duplicate_object then null; end $$;

do $$ begin
  create type account_status as enum ('pending', 'approved', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  -- lifecycle of a bout
  create type fight_state   as enum ('scheduled', 'in_progress', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  -- lifecycle of a single round (round control lives with the official)
  create type round_state   as enum ('pending', 'live', 'locked');
exception when duplicate_object then null; end $$;


-- =====================================================================
-- PROFILES  (1:1 with auth.users)  — Admins, Officials, Judges
-- =====================================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text        not null,
  role        user_role   not null default 'judge',
  status      account_status not null default 'pending',   -- User Approvals flow
  region      text,                                         -- e.g. 'Auckland', 'Canterbury'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'App identity + role + approval status, keyed to Supabase Auth.';

-- Auto-create a pending profile whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'judge',      -- default lowest privilege; admins elevate after review
    'pending'     -- must be approved before scoring
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- EVENTS
-- =====================================================================
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  event_date  date        not null,
  venue       text,
  region      text,
  is_live     boolean     not null default false,
  created_by  uuid        references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_events_date    on public.events (event_date desc);
create index if not exists idx_events_is_live on public.events (is_live) where is_live;


-- =====================================================================
-- FIGHTS
-- =====================================================================
create table if not exists public.fights (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events(id) on delete cascade,
  bout_order        int  not null default 1,
  weight_class      text not null,
  scheduled_rounds  int  not null default 3 check (scheduled_rounds in (3, 5)),
  fighter_a_name    text not null,
  fighter_b_name    text not null,
  fighter_a_corner  text not null default 'red',   -- red/blue for scorecard colour coding
  fighter_b_corner  text not null default 'blue',
  state             fight_state not null default 'scheduled',
  current_round     int  not null default 1,
  created_at        timestamptz not null default now(),
  unique (event_id, bout_order)
);
create index if not exists idx_fights_event on public.fights (event_id);
create index if not exists idx_fights_state on public.fights (state);


-- =====================================================================
-- FIGHT_JUDGES  — which judges are assigned to which bout.
-- This assignment is the backbone of "a judge only sees/scores their bouts".
-- =====================================================================
create table if not exists public.fight_judges (
  fight_id    uuid not null references public.fights(id) on delete cascade,
  judge_id    uuid not null references public.profiles(id) on delete cascade,
  seat        int,                                   -- 1..3, optional
  assigned_at timestamptz not null default now(),
  primary key (fight_id, judge_id)
);
create index if not exists idx_fight_judges_judge on public.fight_judges (judge_id);


-- =====================================================================
-- ROUNDS  — round control owned by the official (start / lock a round).
-- =====================================================================
create table if not exists public.rounds (
  fight_id     uuid not null references public.fights(id) on delete cascade,
  round_number int  not null check (round_number between 1 and 5),
  state        round_state not null default 'pending',
  started_at   timestamptz,
  locked_at    timestamptz,
  primary key (fight_id, round_number)
);
create index if not exists idx_rounds_live on public.rounds (fight_id) where state = 'live';


-- =====================================================================
-- SCORES  — one card per judge per round.
-- =====================================================================
create table if not exists public.scores (
  id               uuid primary key default gen_random_uuid(),
  fight_id         uuid not null,
  round_number     int  not null,
  judge_id         uuid not null references public.profiles(id) on delete cascade,
  fighter_a_score  int  not null check (fighter_a_score between 6 and 10),
  fighter_b_score  int  not null check (fighter_b_score between 6 and 10),
  -- 10-point-must: at least one fighter must score a 10 on a scored round
  note             text,                              -- e.g. 'point deduction, low blow'
  is_locked        boolean not null default false,    -- flips true when round is locked
  submitted_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint scores_ten_point_must check (fighter_a_score = 10 or fighter_b_score = 10),
  -- composite FK ties the score to a real round of that fight
  constraint scores_round_fk foreign key (fight_id, round_number)
    references public.rounds (fight_id, round_number) on delete cascade,
  -- one submission per judge / fight / round (idempotent upserts)
  unique (judge_id, fight_id, round_number)
);
create index if not exists idx_scores_fight_round on public.scores (fight_id, round_number);
create index if not exists idx_scores_judge       on public.scores (judge_id);


-- =====================================================================
-- SCORE_AUDIT  — immutable trail for dispute resolution.
-- =====================================================================
create table if not exists public.score_audit (
  id          bigint generated always as identity primary key,
  score_id    uuid,
  judge_id    uuid,
  fight_id    uuid,
  round_number int,
  action      text,                                   -- INSERT / UPDATE
  old_values  jsonb,
  new_values  jsonb,
  changed_at  timestamptz not null default now()
);
create index if not exists idx_score_audit_fight on public.score_audit (fight_id, round_number);

create or replace function public.audit_scores()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.score_audit(score_id, judge_id, fight_id, round_number, action, old_values, new_values)
  values (
    coalesce(new.id, old.id),
    coalesce(new.judge_id, old.judge_id),
    coalesce(new.fight_id, old.fight_id),
    coalesce(new.round_number, old.round_number),
    tg_op,
    case when tg_op = 'UPDATE' then to_jsonb(old) end,
    to_jsonb(new)
  );
  return new;
end $$;

drop trigger if exists trg_audit_scores on public.scores;
create trigger trg_audit_scores
  after insert or update on public.scores
  for each row execute function public.audit_scores();

-- Immutability: once a score row is locked, it can never be edited again.
create or replace function public.prevent_locked_score_edit()
returns trigger language plpgsql as $$
begin
  if old.is_locked then
    raise exception 'Score for judge % (fight %, round %) is locked and cannot be changed.',
      old.judge_id, old.fight_id, old.round_number
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_lock_scores on public.scores;
create trigger trg_lock_scores
  before update on public.scores
  for each row execute function public.prevent_locked_score_edit();


-- =====================================================================
-- HELPER FUNCTIONS  (SECURITY DEFINER — avoids RLS recursion on profiles)
-- =====================================================================
create or replace function public.current_role_is(target user_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = target
      and p.status = 'approved'
  );
$$;

create or replace function public.is_admin()    returns boolean language sql stable
  as $$ select public.current_role_is('admin') $$;

-- officials (and admins) get read-all on live data
create or replace function public.is_official() returns boolean language sql stable
  security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('official','admin') and p.status = 'approved'
  );
$$;

create or replace function public.is_assigned_judge(f_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.fight_judges fj
    join public.profiles p on p.id = fj.judge_id
    where fj.fight_id = f_id
      and fj.judge_id = auth.uid()
      and p.status = 'approved'
  );
$$;

create or replace function public.round_is_live(f_id uuid, r_num int)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rounds
    where fight_id = f_id and round_number = r_num and state = 'live'
  );
$$;


-- =====================================================================
-- ROW-LEVEL SECURITY
-- =====================================================================
alter table public.profiles     enable row level security;
alter table public.events       enable row level security;
alter table public.fights       enable row level security;
alter table public.fight_judges enable row level security;
alter table public.rounds       enable row level security;
alter table public.scores       enable row level security;
alter table public.score_audit  enable row level security;

-- ---------- profiles ----------
create policy "profiles: read own or official"
  on public.profiles for select
  using (id = auth.uid() or public.is_official());

create policy "profiles: update own basic fields"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());
-- NOTE: guard role/status escalation with a BEFORE UPDATE trigger (below)
-- so a self-update cannot change role or status.

create policy "profiles: admin full manage"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());

-- Stop non-admins from elevating their own role / approving themselves.
create or replace function public.guard_profile_privilege()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.role   := old.role;
    new.status := old.status;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_guard_profile on public.profiles;
create trigger trg_guard_profile
  before update on public.profiles
  for each row execute function public.guard_profile_privilege();

-- ---------- events ----------
create policy "events: officials read all"
  on public.events for select using (public.is_official());
create policy "events: assigned judges read"
  on public.events for select
  using (exists (
    select 1 from public.fights f
    join public.fight_judges fj on fj.fight_id = f.id
    where f.event_id = events.id and fj.judge_id = auth.uid()
  ));
create policy "events: officials write"
  on public.events for all
  using (public.is_official()) with check (public.is_official());

-- ---------- fights ----------
create policy "fights: officials read all"
  on public.fights for select using (public.is_official());
create policy "fights: assigned judges read"
  on public.fights for select using (public.is_assigned_judge(id));
create policy "fights: officials write"
  on public.fights for all
  using (public.is_official()) with check (public.is_official());

-- ---------- fight_judges ----------
create policy "fj: judge reads own assignments"
  on public.fight_judges for select
  using (judge_id = auth.uid() or public.is_official());
create policy "fj: officials manage"
  on public.fight_judges for all
  using (public.is_official()) with check (public.is_official());

-- ---------- rounds ----------
create policy "rounds: officials read all"
  on public.rounds for select using (public.is_official());
create policy "rounds: assigned judges read"
  on public.rounds for select using (public.is_assigned_judge(fight_id));
create policy "rounds: officials control"
  on public.rounds for all
  using (public.is_official()) with check (public.is_official());

-- ---------- scores ----------
-- Officials (and admins) read every card, instantly, for the master scorecard.
create policy "scores: officials read all"
  on public.scores for select using (public.is_official());

-- A judge can read only their own cards.
create policy "scores: judge reads own"
  on public.scores for select using (judge_id = auth.uid());

-- A judge can write only their own card, only for a bout they're assigned to,
-- and only while that round is live.
create policy "scores: judge inserts own live"
  on public.scores for insert
  with check (
    judge_id = auth.uid()
    and public.is_assigned_judge(fight_id)
    and public.round_is_live(fight_id, round_number)
  );

create policy "scores: judge updates own live"
  on public.scores for update
  using (
    judge_id = auth.uid()
    and public.is_assigned_judge(fight_id)
    and public.round_is_live(fight_id, round_number)
    and is_locked = false
  )
  with check (judge_id = auth.uid());
-- (No DELETE policy anywhere = scores can never be deleted by users.)

-- ---------- score_audit ----------
create policy "audit: officials read"
  on public.score_audit for select using (public.is_official());
-- inserts happen via SECURITY DEFINER trigger only; no user insert policy.


-- =====================================================================
-- LOCKING A ROUND  — official calls this; it flips every card to locked.
-- Runs as definer so the lock write bypasses the "no edit after lock" rule
-- in a controlled way, and stamps rounds + scores atomically.
-- =====================================================================
create or replace function public.lock_round(f_id uuid, r_num int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_official() then
    raise exception 'Only officials may lock a round.' using errcode = '42501';
  end if;

  update public.rounds
     set state = 'locked', locked_at = now()
   where fight_id = f_id and round_number = r_num;

  -- Lock cards directly (skip the immutability trigger by disabling it in-tx).
  alter table public.scores disable trigger trg_lock_scores;
  update public.scores
     set is_locked = true, updated_at = now()
   where fight_id = f_id and round_number = r_num;
  alter table public.scores enable trigger trg_lock_scores;
end $$;


-- =====================================================================
-- REALTIME  — expose live tables to officials' dashboards.
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.scores;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.rounds;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.fights;
exception when duplicate_object then null; end $$;
