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

Two surfaces, one database:

- **Roundmaster (Judge PWA)** — mobile-first, installable, offline-first. Judges tap round scores. *This repo scaffolds this surface in full.*
- **FightTrack (Officials/Admin dashboard)** — desktop web. Officials watch the master scorecard update live, control rounds (start/lock), and approve users. *Schema + realtime + RLS fully support it; the dashboard UI is the natural next build.*

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

See `supabase/schema.sql` for the full DDL, RLS policies, triggers, and the `lock_round()` function.

---

## 5. Row-Level Security reasoning

RLS is on for every table. Highlights:

- Authorization checks live in `SECURITY DEFINER` helper functions (`is_official()`, `is_admin()`, `is_assigned_judge()`, `round_is_live()`) so policies stay readable and don't recurse on `profiles`.
- **Judges INSERT/UPDATE scores** only when: the row is theirs **and** they're assigned to the bout **and** the round is live **and** the card isn't locked.
- **Officials/admins SELECT all scores** — this is what powers the instant master scorecard.
- **No DELETE policy exists on `scores` or `score_audit`** — data is append-only by construction.
- `lock_round(fight_id, round_number)` (official-only) atomically stamps the round `locked` and flips every card `is_locked = true`; after that the immutability trigger rejects edits.

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

**Included & complete:** full DB schema + RLS + audit/immutability + round-lock; judge auth (magic-link); the offline-first scoring card; PWA config (manifest, SW, next.config, layout metadata).

**Natural next build (schema already supports it):** the FightTrack officials dashboard — master scorecard consolidating three judges live, round-control buttons calling `lock_round()`, the User Approvals screen, and Judge Performance/trend analytics (all readable under the official RLS policies). Say the word and I'll scaffold it.
