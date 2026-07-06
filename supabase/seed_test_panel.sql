-- ============================================================
-- TEST ONLY: add two extra judges and score round 1 so the
-- official page shows a full 3-judge panel and a real decision.
-- Safe to re-run (it clears the test judges first).
-- Remove them later with the DELETE at the very bottom.
-- ============================================================
do $$
declare
  v_fight uuid := '2570fb04-a4d7-4ba4-8797-1cfeebb338f4';  -- your test bout
  v_j2 uuid := gen_random_uuid();
  v_j3 uuid := gen_random_uuid();
begin
  -- Clear any previous run (cascades to their profile/assignments/scores).
  delete from auth.users where email in ('judge2@nzmmaf.test', 'judge3@nzmmaf.test');

  -- Minimal auth users. The on_auth_user_created trigger creates their
  -- profiles automatically (as judge / pending). Password is a dummy: these
  -- accounts are for display only and are never signed in to.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  ) values
    ('00000000-0000-0000-0000-000000000000', v_j2, 'authenticated', 'authenticated',
     'judge2@nzmmaf.test', '$2a$10$testonlytestonlytestonlytestonlytestonlytestonl',
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{"full_name":"Test Judge Two"}'::jsonb),
    ('00000000-0000-0000-0000-000000000000', v_j3, 'authenticated', 'authenticated',
     'judge3@nzmmaf.test', '$2a$10$testonlytestonlytestonlytestonlytestonlytestonl',
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{"full_name":"Test Judge Three"}'::jsonb);

  -- Approve them (the guard trigger blocks status changes for non-admins).
  alter table public.profiles disable trigger trg_guard_profile;
  update public.profiles set status = 'approved', full_name = 'Test Judge Two'   where id = v_j2;
  update public.profiles set status = 'approved', full_name = 'Test Judge Three' where id = v_j3;
  alter table public.profiles enable trigger trg_guard_profile;

  -- Assign both to the bout.
  insert into public.fight_judges (fight_id, judge_id, seat)
  values (v_fight, v_j2, 2), (v_fight, v_j3, 3)
  on conflict do nothing;

  -- Round 1 cards: Judge Two -> Fighter A 10-9, Judge Three -> Fighter B 10-9.
  -- With your own card (Fighter A) that makes it 2-1 -> Split decision: Fighter A.
  -- Flip Judge Three to (10, 9) to see a Unanimous decision instead.
  insert into public.scores (fight_id, round_number, judge_id, fighter_a_score, fighter_b_score, margin_tag)
  values
    (v_fight, 1, v_j2, 10, 9, 'close'),
    (v_fight, 1, v_j3, 9, 10, 'decisive')
  on conflict (judge_id, fight_id, round_number) do update
    set fighter_a_score = excluded.fighter_a_score,
        fighter_b_score = excluded.fighter_b_score,
        margin_tag = excluded.margin_tag;
end $$;

-- To remove the test judges again, run just this line:
-- delete from auth.users where email in ('judge2@nzmmaf.test', 'judge3@nzmmaf.test');
