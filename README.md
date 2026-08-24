# Your Reflection

A personal AI companion that learns how you think, feel, and grow — from your
own words, journal entries, and activity data. See the full product spec in
the PRD shared with this repo (v1.3).

**Status:** Sprint 0 (Foundation) and Sprint 1 (Onboarding + Character
Profile) are built. Chat core, journaling, goals, charts, and integrations
land in later sprints.

## Stack

- Frontend: React + Tailwind CSS (Vite)
- Backend / DB / Auth: Supabase (Postgres + RLS + pgvector + pg_cron)
- Embeddings: Supabase built-in `gte-small` (384 dims), via a Supabase Edge Function
- AI: Groq (`openai/gpt-oss-120b`, fallback `openai/gpt-oss-20b`) via a Vercel serverless function — key never reaches the browser
- Hosting: Vercel

## Local setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create a Supabase project** at [supabase.com](https://supabase.com), then:
   - Under **Database → Extensions**, enable `vector` (pgvector) and `pg_cron`
     if they aren't already on.
   - In the SQL editor, run the migrations in order:
     `supabase/migrations/0001_init.sql`, then
     `supabase/migrations/0002_v1_3_memory_upgrade.sql`. Together these
     create every table (`profiles`, `journal_entries`, `snaps`, `goals`,
     `suggestions`, `calendar_events`, `strava_data`, `chat_history`,
     `memory_summaries`, `taste_profile`, `pattern_extractions`,
     `dismissed_suggestions`, `response_signals`) with row-level security so
     each account can only ever see its own data.
   - Deploy the embedding Edge Function:
     ```bash
     npx supabase login
     npx supabase link --project-ref <your-project-ref>
     npx supabase functions deploy embed-text
     ```
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

3. **Get a Groq API key** from the
   [Groq Console](https://console.groq.com/keys) — free tier, no credit card.

4. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `GROQ_API_KEY`.

5. **Run the app**

   ```bash
   npm run dev
   ```

   Sign up (or use Google sign-in) and you'll land straight in the AI
   interview onboarding flow. Finishing it takes you to the Character
   Profile page, where the AI's suggestions from the interview show up as
   approval bubbles.

   Note: `/api/*` serverless functions only run under `vercel dev`, not the
   plain Vite dev server. Use `npx vercel dev` instead of `npm run dev` if
   you want to exercise onboarding/chat locally without deploying — the
   onboarding interview and profile extraction both depend on those
   functions.

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
  hooks/useProfile.ts        Loads/refreshes the current user's profile row
  lib/supabase.ts            Supabase client
  lib/database.types.ts      Hand-written types mirroring the SQL schema
  lib/api.ts                 Authenticated fetch wrapper for /api/*
  lib/embeddings.ts          Calls the embed-text Edge Function
  lib/suggestions.ts         Suggestion fingerprinting + dismissal tracking
  types/onboarding.ts        Shape of the onboarding extraction JSON
  types/suggestions.ts       Suggestion bubble discriminated union
  pages/                     Login, Signup, AuthCallback, Home, Onboarding, CharacterProfile
  components/
    ProtectedRoute.tsx
    SuggestionBubble.tsx      Accept/Dismiss approval bubble (PRD 5.2, 7.3)
api/
  onboarding-chat.ts          One turn of the AI interview (Groq)
  onboarding-finalize.ts      Extracts profile/taste suggestions (Groq, JSON mode)
  groq-test.ts                Server-side Groq connectivity check
  _lib/verifyUser.ts          Verifies the caller's Supabase session
  _lib/groq.ts                Groq chat completions wrapper (primary + fallback model)
  _lib/systemPrompt.ts        IDENTITY/RULES/BEHAVIOUR prompt blocks (PRD 7.1)
supabase/
  migrations/0001_init.sql                  Core schema + RLS policies
  migrations/0002_v1_3_memory_upgrade.sql   pgvector, pg_cron, taste_profile,
                                             pattern_extractions, dismissed_suggestions,
                                             response_signals, embedding columns + HNSW
  functions/embed-text/index.ts             Supabase Edge Function: gte-small embeddings
```

## Security notes

- The Groq API key lives only in Vercel's server environment (`GROQ_API_KEY`,
  no `VITE_` prefix) and is never sent to the browser.
- Every table has row-level security scoped to `auth.uid()`, so one account
  can never read or write another account's rows, even via the public anon
  key.
- `/api/*` functions require a valid Supabase session token before doing
  anything, so they can't be used as an open proxy.
- The `embed-text` Edge Function also requires a valid Supabase session JWT
  (default Edge Function behaviour) — it can't be called anonymously.
