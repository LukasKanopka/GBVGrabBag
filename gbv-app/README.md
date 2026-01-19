# Gator Beach Volleyball Tournament App

Mobile-first tournament management web application for grab-bag style beach volleyball events.

Stack:
- Vue 3 + Vite + TypeScript
- Pinia (state), Vue Router
- Tailwind CSS v4 + Headless UI + Heroicons
- Supabase (Postgres, Auth, Realtime)
- Netlify (hosting)

Key entry points:
- App shell: [src/App.vue](src/App.vue)
- Router: [src/router/index.ts](src/router/index.ts)
- Global styles + Tailwind tokens: [src/style.css](src/style.css)
- Supabase client: [src/lib/supabase.ts](src/lib/supabase.ts)
- Session store (admin auth + access code): [src/stores/session.ts](src/stores/session.ts)
- Types for DB tables: [src/types/db.ts](src/types/db.ts)
- Supabase schema SQL: [supabase/schema.sql](supabase/schema.sql)
- Pages: public ([src/pages/TournamentPublic.vue](src/pages/TournamentPublic.vue)), score entry ([src/pages/ScoreEntry.vue](src/pages/ScoreEntry.vue)), live scoreboard ([src/pages/LiveScoreboard.vue](src/pages/LiveScoreboard.vue)), admin login ([src/pages/AdminLogin.vue](src/pages/AdminLogin.vue)), admin dashboard ([src/pages/AdminDashboard.vue](src/pages/AdminDashboard.vue))

## Quickstart

1) Install dependencies
   npm install

2) Configure environment variables
   cp .env.example .env
   # edit the values
   # VITE_SUPABASE_URL=
   # VITE_SUPABASE_ANON_KEY=

Example template: [gbv-app/.env.example](.env.example)

3) Run dev server
   npm run dev
   # open http://localhost:5173

4) Verify Tailwind
   Tailwind v4 is configured via PostCSS plugin (@tailwindcss/postcss) and imported in [src/style.css](src/style.css:1).
   If you see a PostCSS overlay error, ensure:
   - devDependency @tailwindcss/postcss is installed
   - [postcss.config.js](postcss.config.js:1) uses:
     import tailwindcss from '@tailwindcss/postcss';
     import autoprefixer from 'autoprefixer';
     export default { plugins: [tailwindcss(), autoprefixer()] };

## Supabase Setup

1) Create a Supabase project
   - Get your Project URL and anon public key from Project Settings > API
   - Put them in .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)

2) Apply database schema
   - Open the SQL Editor in Supabase
   - Paste the contents of [supabase/schema.sql](supabase/schema.sql:1) and run

Tables:
- tournaments, pools, teams, matches, schedule_templates
- RLS: read for all, authenticated writes (MVP). Tighten policies later.

Triggers and constraints:
- winner must be one of the participants
- live scoring sanity checks

3) Realtime (for live scoreboard)
   In Supabase, enable Realtime on the matches table for INSERT/UPDATE to power the live score indicator. Client bindings will be added in subsequent iterations.

## Netlify Deployment

1) Create a new site from the repo
2) Set env vars in Netlify Site settings > Build & deploy > Environment
   - VITE_SUPABASE_URL
   - VITE_SUPABASE_ANON_KEY
3) Build settings
   - Build command: npm run build
   - Publish directory: dist
4) Optional: add a netlify.toml for defaults (included if present)

## Available Scripts

- npm run dev: Start Vite dev server
- npm run build: Type-check (vue-tsc) and build
- npm run preview: Preview the production build locally

## Routing

- /:accessCode? - Public tourney view (stores access code locally)
- /:accessCode/score - Score entry (MVP placeholder)
- /:accessCode/live - Live scoreboard (MVP local state; wire to Realtime next)
- /admin/login - Admin email/password login page
- /admin - Admin dashboard (guarded route; requires admin session)

Guard: see [router.beforeEach](src/router/index.ts:34).

## Tailwind v4 Theming

Theme tokens are defined in [src/style.css](src/style.css:4) using @theme:
- --color-gbv-blue, --color-gbv-orange, --color-gbv-green
- --color-gbv-bg (off-white for outdoor readability), --color-gbv-ink (high-contrast text)

Usage examples:
- bg-gbv-blue, text-gbv-orange, bg-gbv-bg, text-gbv-ink

## PRD Coverage (MVP scaffolding implemented)

- Player Access Code flow: [TournamentPublic.vue](src/pages/TournamentPublic.vue:1)
- Score Entry page stub: [ScoreEntry.vue](src/pages/ScoreEntry.vue:1)
- Live Scoreboard stub with +1/-1/Flip: [LiveScoreboard.vue](src/pages/LiveScoreboard.vue:1)
- Admin login page: [AdminLogin.vue](src/pages/AdminLogin.vue:1)
- Admin dashboard placeholders: [AdminDashboard.vue](src/pages/AdminDashboard.vue:1)
- Supabase DB schema: [supabase/schema.sql](supabase/schema.sql:1)
- Session store for admin/user: [stores/session.ts](src/stores/session.ts:1)

Coming next:
- Schedule Template Management UI (CRUD) and validation
- Pools & Seeds Management UI (drag/drop)
- generateSchedule using schedule_templates
- Bracket generation (single elimination + best-of-3 option per tournament)
- Live scoreboard w/ Supabase Realtime stream + global LIVE indicator
- Access control hardening (RLS by tournament, role-based admin)

## Project Structure

src/
- App.vue: Layout shell (header/footer)
- main.ts: createApp + Pinia + Router bootstrap
- style.css: Tailwind import + tokens
- router/: Vue Router (routes + admin guard)
- stores/: Pinia stores (session)
- lib/: Supabase client factory
- types/: Shared types (DB + rules)
- pages/: Route components (public/admin)

supabase/
- schema.sql: Full schema and policies

## Notes

- Admin authentication uses Supabase email/password. For production, define dedicated Admin users and tighten RLS by role/JWT claims.
- Players use the access code to view data and submit scores; for MVP, writes are allowed to authenticated (Anon) users per RLS policy. This will be restricted in later iterations.


## Admin Testing: Fill Pool Scores Randomly

To quickly test bracket generation without manually entering pool scores:

- Generate pool schedule using [src/pages/AdminGenerateSchedule.vue](src/pages/AdminGenerateSchedule.vue)
- Open the Bracket admin page [src/pages/AdminBracket.vue](src/pages/AdminBracket.vue)
- Click “Fill Pool Scores Randomly”
  - This calls [fillRandomPoolScores()](src/lib/testData.ts:93) to populate only pool matches that have no scores
  - Winners are 50/50 random between Team 1 and Team 2
  - Scores follow [GameRules.pool](src/types/db.ts:30) with defaults: target 21, cap 25, win-by-2; plausible outcomes like 21–17, 22–20, 23–21, and occasional 25–24 at cap
  - Existing scored matches are not modified; matches missing a team are skipped
- Click “Generate Bracket”
  - This uses [generateBracket()](src/lib/bracket.ts:315) with standings computed from the filled pool scores

Notes:
- To reset, you can delete pool matches on the Generate Schedule page [src/pages/AdminGenerateSchedule.vue](src/pages/AdminGenerateSchedule.vue) and re-generate.
- The helper lives at [src/lib/testData.ts](src/lib/testData.ts) and is wired into [src/pages/AdminBracket.vue](src/pages/AdminBracket.vue).
