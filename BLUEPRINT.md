# NZMMAF FightTrack / Roundmaster — Technical Blueprint

Rebuild of the Base44 prototype on **Next.js (App Router) + Tailwind + Supabase + Vercel**.

---

## 1. Stack verdict (you invited a challenge)

Your proposed stack is the right call — Next.js on Vercel with Supabase for Postgres + Auth + Realtime is a well-trodden, low-ops path for exactly this shape of app. Two adjustments and two additions worth making before you build:

- **PWA tooling: use Serwist, not `next-pwa`.** `next-pwa` is effectively unmaintained; Serwist (`@serwist/next`) is its successor and is what the Next.js docs now point to for App Router offline support. Everything here uses Serwist.
- **Auth session storage: plain `@supabase/supabase-js` with `localStorage` persistence**, not the SSR cookie helper. An *installed* standalone PWA that gets backgrounded ringside survives relaunch far more reliably on a persisted local session than on cookie round-trips — and it keeps working offline.
- **Add an offline write-queue (IndexedDB).** Arena Wi-Fi/cellular is unreliable. A judge's tap is written to IndexedDB *first*, then flushed to Supabase; if the network is down the card is safe and syncs on reconnect. This is the single most important reliability decision for a live-scoring app and the prototype almost certainly lacked it.
- **Add score immutability + an audit trail.** For a sanctioned combat sport, a locked round must be tamper-evident. The schema enforces append-only scores (no user DELETE policy anywhere), a "no edit after lock" trigger, and a `score_audit` table capturing every INSERT/UPDATE.

The one thing to *not* over-engineer: you do not need a separate backend service. RLS + a couple of `SECURITY DEFINER` functions do the authorization work inside Postgres.

---

## 2. System shape

Two surfaces, one database — **both built and live in this repo**:

- **Roundmaster (Judge PWA)** — mobile-first, installable, offline-first. Judges tap round scores.
- **FightTrack (Officials/Admin dashboard)** — mobile-first web (not desktop-only as originally scoped). Officials create events/bouts, assign judges, watch every judge's card update live, control rounds (open/lock), record point deductions, and close out bouts. A separate admin hub handles user approvals and role management.

```
Judge phone (PWA)  ──tap──►  IndexedDB queue  ──flush──►  Supabase Postgres
                                                              │  (RLS enforced)
Officials laptop  ◄──Realtime (scores/rounds/fights)──────────┘
```

---

## 3. Roles & the approval flow

Mirrors the prototype's *User Approvals* page.

| Role | Reads | Writes |
|---|---|---|
| **judge** | Only bouts they're assigned to; only their own cards | Their own card, only while the round is `live`, only if approved |
| **official** | All live data instantly (every judge's card) | Events, fights, round control, judge assignments |
| **admin** | Everything | Everything, incl. role/status changes |

New sign-ups land as `role = judge`, `status = pending` (auto-created by the `on_auth_user_created` trigger). Nobody can score until an admin flips them to `approved`. A `guard_profile_privilege` trigger blocks self-elevation, so a judge can't approve themselves or promote to official.

---

## 4. Data model

`profiles` (↔ `auth.users`) · `events` · `fights` · `fight_judges` (assignment) · `rounds` (round control) · `scores` · `score_audit`.

Key design choices:

- **`fight_judges` is the backbone of authorization.** "A judge only sees/scores their bouts" is expressed as an assignment row, checked by `is_assigned_judge(fight_id)` in RLS — not by trusting the client.
- **`rounds` gives the official control.** A judge can only write while `rounds.state = 'live'`. Advancing/locking rounds is an official action; judges' cards follow via Realtime.
- **`scores` is one row per `(judge_id, fight_id, round_number)`** with a unique constraint, so re-taps are idempotent upserts (critical for the offline queue). A `CHECK` enforces the 10-point-must (at least one fighter scores a 10) and the 6–10 range.
- **Composite FK** ties every score to a real round of that fight.
- **`fights.state`** (`scheduled` → `in_progress` → `completed`/`cancelled`) tracks the bout's lifecycle, separately from `rounds.state`. Opening round 1 flips `scheduled` → `in_progress`; the `complete_fight()` RPC closes the bout out.

See `supabase/schema.sql` for the base DDL, RLS policies, triggers, and `lock_round()`. Three additive migrations layer on top (all idempotent, run once each in the SQL editor):

| Migration | Adds |
|---|---|
| `supabase/phase2.sql` | Per-round point deductions (`fighter_a_deduction`/`_b`, `deduction_note`); bout format (`round_minutes`, `is_championship`). |
| `supabase/phase2b_margin_tag.sql` | `scores.margin_tag` (`close`/`decisive`) — a judge's optional round-margin annotation. |
| `supabase/phase3_fight_lifecycle.sql` | `fights.result_method`/`result_winner`/`result_round`/`result_note`/`completed_at`, a DB check that `state = 'completed'` requires a recorded method, and the `complete_fight()` RPC (official-only; bulk-locks every remaining round and stamps the result atomically). |

`supabase/seed_test_panel.sql` is a manual dev fixture (adds two extra judges + scores to a named test bout) — not part of the deployed schema.

---

## 5. Row-Level Security reasoning

RLS is on for every table. Highlights:

- Authorization checks live in `SECURITY DEFINER` helper functions (`is_official()`, `is_admin()`, `is_assigned_judge()`, `round_is_live()`) so policies stay readable and don't recurse on `profiles`.
- **Judges INSERT/UPDATE scores** only when: the row is theirs **and** they're assigned to the bout **and** the round is live **and** the card isn't locked.
- **Officials/admins SELECT all scores** — this is what powers the instant master scorecard.
- **No DELETE policy exists on `scores` or `score_audit`** — data is append-only by construction.
- `lock_round(fight_id, round_number)` (official-only) atomically stamps the round `locked` and flips every card `is_locked = true`; after that the immutability trigger rejects edits.
- `complete_fight(fight_id, method, winner, round, note)` (official-only) is the bout-closure counterpart: it locks *every remaining round* in one call (so a KO/TKO/Submission/DQ mid-round still seals off further scoring) and stamps `fights.state = 'completed'` with the result. A DB check constraint refuses `state = 'completed'` without a `result_method`, so the closure can't happen silently through a raw client update.

---

## 6. Offline-first score capture

`lib/offlineQueue.ts` (IndexedDB via `idb`):

1. Judge taps CONFIRM → `enqueueScore()` writes to IndexedDB keyed by `fight:round:judge`.
2. Immediate flush attempt via Supabase `upsert(..., { onConflict: 'judge_id,fight_id,round_number' })`.
3. Offline or failed → stays queued; a `window 'online'` listener auto-flushes on reconnect.
4. Terminal errors (RLS denial `42501`, locked round) are dropped from the queue rather than retried forever.

The UI reflects three states on the CONFIRM button: **saved** (green, server-confirmed), **saved offline — will sync** (amber), **retry** (red). A header badge shows online/offline and queued count.

The service worker (`app/sw.ts`) forces **NetworkOnly** for Supabase REST calls — score writes must never be served from cache — while precaching the app shell and falling back to `/~offline` for navigations.

---

## 7. The judge interface

`app/judge/[fightId]/ScoringCard.tsx` — high-contrast dark theme, oversized tap targets (≥64px), fighter columns colour-coded by corner, 10-9 / 10-8 / 10-7 / even.

**Double-submit protection** is a two-layer state lock: the `submit` state gates the confirm handler (`if (confirmDisabled) return`) so a fast double-tap can't fire twice, and the DB unique constraint makes any duplicate an idempotent upsert rather than a second card. Once saved, the whole card disables until the official advances the round (pushed live via Realtime).

---

## 8. PWA / Vercel deployment

Files provided: `app/manifest.ts` (standalone + maskable icons), `next.config.mjs` (Serwist + security headers), `app/sw.ts` (service worker), plus `viewport`/`appleWebApp` metadata in `app/layout.tsx` for iOS standalone + notch handling.

Steps:

1. `npm install`
2. Create the Supabase project, run `supabase/schema.sql` in the SQL editor.
3. Copy `.env.example` → `.env.local`, fill `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY`.
4. Add real icons to `public/icons/` (192/512 + maskable). Generate from the NZMMAF logo.
5. Apply `TSCONFIG_NOTES.txt` (add `webworker` lib, `@serwist/next/typings` type, `@/*` path alias, exclude `public/sw.js`).
6. `npm run build && npm start` to test the SW locally (it's disabled in `next dev`), then deploy to Vercel and set the two env vars.
7. Enable Realtime on `scores`, `rounds`, `fights` (the schema already adds them to the `supabase_realtime` publication).

---

## 9. Scope of this deliverable vs. next steps

**Included & complete:**
- Full DB schema + RLS + audit/immutability + round-lock, plus the phase 2/2b/3 migrations (deductions, format, margin tags, fight lifecycle + closure).
- Judge auth (magic-link) and the offline-first scoring card, including live round-follow, per-round notes/margin tags, and a bout-complete/cancelled banner.
- PWA config (manifest, SW, next.config, layout metadata).
- **FightTrack officials dashboard** (`/admin`): user approvals (approve/suspend/change role), event & bout creation, judge assignment, and per-bout round control (`/official/[fightId]`) — open/lock rounds, point deductions with a reason note, live per-judge submission chips, a computed unanimous/majority/split/draw decision, and bout closure (decision/KO/TKO/submission/DQ/no-contest, with a confirmation step) via `complete_fight()`. Events can be toggled live/not-live from the admin list.

**Natural next build:** Judge Performance / trend analytics (consistency across a judge's history, deviation from panel consensus on split/majority decisions) — the schema already supports it under the official RLS policies, since every score is retained and attributed to a judge and a fight.

**Known gaps:**
- No automated tests.
- `supabase/seed_test_panel.sql` is a manual, non-repeatable dev fixture — worth turning into a proper seed script if local/staging environments multiply.
- Single squashed initial commit — no incremental git history yet to lean on for "why" questions.
