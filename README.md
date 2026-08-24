# Your Reflection

A personal AI companion that learns how you think, feel, and grow — from your
own words, journal entries, and activity data. See the full product spec in
the PRD shared with this repo.

This repo is at **Sprint 0 — Foundation**: project scaffold, database schema,
auth, and a Claude API connectivity check. Chat, journaling, goals, charts,
and integrations land in later sprints.

## Stack

- Frontend: React + Tailwind CSS (Vite)
- Backend / DB / Auth: Supabase (Postgres + RLS)
- AI: Claude API (via a Vercel serverless function, key never reaches the browser)
- Hosting: Vercel

## Local setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a Supabase project** at [supabase.com](https://supabase.com), then:
   - In the SQL editor, run `supabase/migrations/0001_init.sql`. This creates
     every Sprint 0 table (`profiles`, `journal_entries`, `snaps`, `goals`,
     `suggestions`, `calendar_events`, `strava_data`, `chat_history`,
     `memory_summaries`) with row-level security so each account can only
     ever see its own data.
   - Under **Authentication → Providers**, enable **Email** and **Google**.
     For Google, you'll need an OAuth client ID/secret from the
     [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
     with the Supabase callback URL added as an authorized redirect URI
     (Supabase shows you the exact URL on that settings page).
   - Under **Authentication → URL Configuration**, add
     `http://localhost:5173/auth/callback` (and your Vercel domain's
     equivalent later) as a redirect URL.
   - Copy the project's **URL** and **anon public key** from
     **Project Settings → API**.

3. **Get a Claude API key** from the
   [Anthropic Console](https://console.anthropic.com/).

4. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and
   `ANTHROPIC_API_KEY`.

5. **Run the app**

   ```bash
   npm run dev
   ```

   Sign up, confirm your email (or use Google sign-in), and use the
   "Test Claude connection" button on the home screen to confirm the
   `/api/claude-test` function can reach Claude with your key.

   Note: `/api/*` serverless functions only run under `vercel dev`, not the
   plain Vite dev server. Use `npx vercel dev` instead of `npm run dev` if
   you want to exercise the Claude test button locally without deploying.

## Deploying to Vercel

1. Push this repo to GitHub and import it in [Vercel](https://vercel.com/new).
2. Vercel auto-detects the Vite framework and `vercel.json`'s build settings.
3. Add the same three environment variables from `.env` in the Vercel
   project's **Settings → Environment Variables**.
4. Add your production domain's `/auth/callback` URL to Supabase's redirect
   URL allow-list, and to the Google OAuth client's authorized redirect URIs.
5. Deploy. Every push to the connected branch gets a preview deployment.

## Project layout

```
src/
  contexts/AuthContext.tsx   Supabase auth session state
  lib/supabase.ts            Supabase client
  lib/database.types.ts      Hand-written types mirroring the SQL schema
  pages/                     Login, Signup, AuthCallback, Home
  components/ProtectedRoute.tsx
api/
  claude-test.ts             Server-side Claude API connectivity check
  _lib/verifyUser.ts         Verifies the caller's Supabase session
supabase/
  migrations/0001_init.sql   Core schema + RLS policies
```

## Security notes

- The Claude API key lives only in Vercel's server environment
  (`ANTHROPIC_API_KEY`, no `VITE_` prefix) and is never sent to the browser.
- Every table has row-level security scoped to `auth.uid()`, so one account
  can never read or write another account's rows, even via the public anon
  key.
- `/api/claude-test` requires a valid Supabase session token before it will
  call Claude, so the endpoint can't be used as an open proxy.
