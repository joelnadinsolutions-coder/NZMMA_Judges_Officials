# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

NZMMAF Roundmaster: a live MMA judging PWA for the NZ Mixed Martial Arts
Federation. Two surfaces, one database:

- **Roundmaster** (judge PWA): offline-first round scoring on phones.
- **FightTrack** (officials/admin): `/admin` for approvals, events, bouts and
  judge assignment; `/official/[fightId]` for round control, deductions and
  bout closure.

Read `BLUEPRINT.md` for the full architecture before making non-trivial
changes.

## Stack

- Next.js 15 App Router, React client components for anything interactive
- Tailwind CSS 4
- Supabase: Postgres + Auth + Realtime, plain `@supabase/supabase-js` v2 with
  localStorage sessions (NOT the SSR cookie helper, by design; see
  `lib/supabase/client.ts`)
- Serwist for the service worker / PWA (`app/sw.ts`, disabled in `next dev`)
- IndexedDB offline write-queue for scores (`lib/offlineQueue.ts`)
- Deployed on Vercel

## Commands

- `npm run dev` - dev server (service worker disabled)
- `npm run build` - production build; requires `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from `.env.local`) or the prerender of
  `/login` fails
- `npm start` - serve the production build (use this to test the SW locally)
- `vercel --prod` - deploy
- No automated tests yet

## Database

Schema and policies live in `supabase/` and are applied by hand in the
Supabase SQL editor: `schema.sql` first, then the idempotent migrations
`phase2.sql`, `phase2b_margin_tag.sql`, `phase3_fight_lifecycle.sql`.
`seed_test_panel.sql` is a manual dev fixture only.

Rules that must not be weakened:

- RLS on every table; authorization goes through the SECURITY DEFINER
  helpers (`is_official()`, `is_admin()`, `is_assigned_judge()`,
  `round_is_live()`), never trusted from the client.
- Scores are append-only: no DELETE policies, immutability trigger after
  lock, `score_audit` records every change.
- New signups become `role=judge, status=pending` via the
  `on_auth_user_created` trigger and are approved at `/admin/approvals`.

## House rules

- NZ English in all copy, comments and commit messages.
- No em-dashes anywhere; use commas, colons or parentheses.
- Short and direct writing.
- Commit after each logical change; never one big squash commit.
- Never touch `.env.local` contents, and never commit real keys. For a local
  build without it, pass placeholder env vars inline on the command.
- Ask before anything destructive (data, schema, force-push, deletion).
- Score writes must never be served from cache: the service worker keeps
  Supabase REST calls NetworkOnly. Do not change that.
