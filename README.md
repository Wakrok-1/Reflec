# Your Reflection

A personal AI companion that learns how you think, feel, and grow — from your
own words, journal entries, and activity data. See the full product spec in
the PRD shared with this repo (v1.5).

**Status:** Sprint 0 (Foundation), Sprint 1 (Onboarding + Character Profile),
Sprint 2 (Chat Core), Sprint 3 (Full Journal + PDF Export), Sprint 4
(Goals + Achievements), and Sprint 5 (Google Calendar + Web Push) are
built. Strava was explicitly scoped out of Sprint 5 — no Strava OAuth,
sync, or context injection exists. Charts land in a later sprint.

## Stack

- Frontend: React + Tailwind CSS (Vite)
- Backend / DB / Auth: Supabase (Postgres + RLS + pgvector + pg_cron)
- Embeddings: Supabase built-in `gte-small` (384 dims), via Supabase Edge Functions
- AI: Groq (`openai/gpt-oss-120b` primary, `openai/gpt-oss-20b` fallback + intent
  classifier) via Vercel serverless functions — key never reaches the browser
- Web search: Tavily, only on explicit user confirmation in chat
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
     `0001_init.sql` → `0002_v1_3_memory_upgrade.sql` →
     `0003_typed_memories.sql` → `0004_vector_search_functions.sql` →
     `0005_journal_title.sql`.
     Together these create every table (`profiles`, `journal_entries`,
     `snaps`, `goals`, `suggestions`, `calendar_events`, `strava_data`,
     `chat_history`, `memory_summaries`, `taste_profile`,
     `pattern_extractions`, `dismissed_suggestions`, `response_signals`,
     `memories`, `private_entries`) with row-level security so each account
     can only ever see its own data, plus the `match_journal_entries` /
     `match_chat_history` vector search functions chat uses for retrieval.
   - Deploy the Edge Functions and set their Groq secret:
     ```bash
     npx supabase login
     npx supabase link --project-ref <your-project-ref>
     npx supabase secrets set GROQ_API_KEY=<your-groq-key>
     npx supabase functions deploy embed-text
     npx supabase functions deploy embed-entry
     npx supabase functions deploy extract-patterns
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

4. **Get a Tavily API key** from [tavily.com](https://tavily.com) — free
   tier, 1000 searches/month. Only used when the user explicitly confirms a
   search in chat.

5. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `GROQ_API_KEY`, and
   `TAVILY_API_KEY`.

6. **Run the app**

   ```bash
   npm run dev
   ```

   Sign up (or use Google sign-in) and you'll land in the AI interview
   onboarding flow. Finishing it takes you to the Character Profile page,
   then into Chat — the main interface.

   Note: `/api/*` serverless functions only run under `vercel dev`, not the
   plain Vite dev server. Use `npx vercel dev` instead of `npm run dev` if
   you want to exercise onboarding/chat locally without deploying.

## Deploying to Vercel

1. Push this repo to GitHub and import it in [Vercel](https://vercel.com/new).
2. Vercel auto-detects the Vite framework and `vercel.json`'s build settings.
   The daily notification sweep runs on Supabase's own pg_cron instead of
   Vercel Cron (see "Scheduling the daily notification sweep" below), so
   no Vercel Cron / paid-plan requirement applies.
3. Add every variable from `.env.example` in the Vercel project's
   **Settings → Environment Variables**.
4. Add your production domain's `/auth/callback` URL to Supabase's redirect
   URL allow-list, and both `/auth/callback` and `/api/google-callback` to
   the Google OAuth client's authorized redirect URIs.
5. Deploy. Every push to the connected branch gets a preview deployment.

## Scheduling the daily notification sweep

The daily check-in / goal-reminder sweep runs on Supabase's own pg_cron,
which invokes a Supabase Edge Function that calls back into this app's
`/api/notifications` for actual delivery — not a Vercel Cron job.

1. Deploy the Edge Function and set its secrets (`CRON_SECRET` must be the
   same value as the Vercel project's `CRON_SECRET` env var):
   ```bash
   npx supabase functions deploy daily-checkin
   npx supabase secrets set GROQ_API_KEY=<your-groq-key> APP_URL=https://<your-app>.vercel.app CRON_SECRET=<your-cron-secret>
   ```
2. Before applying the migration, edit `0007_pg_cron_daily_checkin.sql` and
   replace `<YOUR_PROJECT_REF>` with your actual Supabase project ref (the
   same one in `VITE_SUPABASE_URL`) — that URL isn't a secret, so it's
   fine to commit directly, unlike the key in the next step.
3. One-time manual step in the Supabase SQL editor — store the service
   role key in Vault rather than committing it anywhere:
   ```sql
   select vault.create_secret('<your-service-role-key>', 'daily_checkin_service_role_key');
   ```
   (`alter database postgres set "app.settings.*"` — the previous approach
   here — needs a superuser grant Supabase doesn't give out on shared/
   free-tier projects; it fails with a permission-denied error there.
   Vault works on every tier.)
4. Run migration `0007_pg_cron_daily_checkin.sql` (via `npx supabase db push`
   or the SQL editor) — it enables `pg_net` and schedules the pg_cron job,
   pulling the key out of Vault at call time. If `pg_net`/`pg_cron` aren't
   available on your plan, or the Vault secret from step 3 doesn't exist
   yet, the migration logs a notice and continues rather than failing
   outright — check `select * from cron.job;` to confirm the job actually
   got scheduled.

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
  lib/systemPrompt.ts        SYSTEM_PROMPT — the full chat personality (locked wording)
  lib/contextBuilder.ts      Fills SYSTEM_PROMPT's [MEMORY] placeholders under a token budget
  lib/classGradient.ts       Deterministic class badge gradient (design spec §8)
  types/onboarding.ts        Shape of the onboarding extraction JSON
  types/suggestions.ts       Suggestion bubble discriminated union
  lib/exportBlocks.ts        PDF export builder's Block/CanvasConfig data model
  lib/goals.ts                Big Life Goals/Increments/Bucket List data layer + progress math
  lib/push.ts                  Web Push subscribe/unsubscribe (service worker + subscription storage)
  pages/                     Login, Signup, AuthCallback, Home, Onboarding,
                             CharacterProfile, Chat, Journal, JournalExport, Goals, Achievements
  components/
    ProtectedRoute.tsx
    SuggestionBubble.tsx      Accept/Dismiss approval bubble (PRD 5.2, 7.3)
    MemoryControls.tsx        "What does my AI know about me?" + mark-private toggles
    ConnectedApps.tsx          Google Calendar connect/disconnect + Notifications settings (Sprint 5)
    ui/                       DoveLoader, IslandNav, ChatBubble, TypewriterQuote, SnapInput,
                              GoalCard, MedalBadge, Checkbox, InlineEditableText,
                              ClassBadge/CategoryPill (stubs)
    layout/PageShell.tsx      Linen background + island nav wrapper
    export/
      BlockEditorStep.tsx      Step 2: dnd-kit reorder, inline edit, block library sidebar
      ExportStep.tsx           Step 3: live PDFViewer preview + Download PDF
      pdf/pdfFonts.ts          Registers bundled Poppins WOFF2 with react-pdf
      pdf/ExportDocument.tsx   Minimal + Editorial style renderers, single-day + timeline layouts
api/
  (Vercel Hobby plan caps a project at 12 serverless functions, one per
  api/*.ts file — api/_lib/* doesn't count, it's plain module resolution,
  not a route. The list below is the result of consolidating what used to
  be ~20 single-purpose files down to 10, each dispatching internally on
  either `req.method` or a `body.action` string. `/api/google-callback` is
  preserved as a URL via a `vercel.json` rewrite to `/api/auth`, since
  that path is registered as the redirect_uri in Google Cloud Console and
  changing it there isn't an option this consolidation should force.)
  chat.ts                     Streaming chat: memory injection, vector search, Groq, calendar
  classify-intent.ts          gpt-oss-20b pre-check: on_topic / off_topic / search_needed / calendar_event
  search.ts                   Tavily search, only called on explicit user confirmation
  journal.ts                   action: reflect | prompt | turn-into-journal | distill-to-snap | vision-extract
                                 (AI journal reflection, export-builder prompt, snaps->entry,
                                 entry->one-line snap, Apple Journal screenshot OCR via vision)
  onboarding.ts                 action: chat | finalize — AI interview turn, then profile/taste extraction
  goals.ts                      AI-suggested goal or bucket-list items (Groq, JSON mode)
  auth.ts                       GET = Google's OAuth callback target (exchanges code, stores tokens,
                                 rewritten from /api/google-callback); POST action: google-start =
                                 mints oauth_states row, returns the Google consent URL
  calendar.ts                   action: read | write — next 7 days of events, or writes one
                                 (chat confirm-bubble triggered)
  notifications.ts               Self-service test push, OR the trusted delivery target the
                                 Supabase daily-checkin Edge Function calls (CRON_SECRET-gated)
  health.ts                    Server-side Groq connectivity check
  _lib/verifyUser.ts          Verifies the caller's Supabase session
  _lib/supabaseServer.ts      RLS-scoped Supabase client (no service-role key, ever)
  _lib/supabaseAdmin.ts        Service-role client — ONLY auth.ts's Google callback path and
                                notifications.ts's trusted path
  _lib/googleCalendar.ts       OAuth token exchange/refresh + Calendar API read/write
  _lib/webpush.ts               VAPID-configured web-push wrapper
  _lib/conversationAnalyzer.ts  Conversation Engine's gpt-oss-20b pre-call + directive builder
  _lib/groq.ts                Groq chat wrapper — primary/fallback/classifier/vision, streaming
  _lib/systemPrompt.ts        Onboarding-only IDENTITY/RULES/BEHAVIOUR blocks (Sprint 1)
supabase/
  migrations/0001_init.sql                    Core schema + RLS policies
  migrations/0002_v1_3_memory_upgrade.sql     pgvector, pg_cron, taste_profile,
                                               pattern_extractions, dismissed_suggestions,
                                               response_signals, embedding columns + HNSW
  migrations/0003_typed_memories.sql          memories, private_entries
  migrations/0004_vector_search_functions.sql match_journal_entries, match_chat_history RPCs
  migrations/0005_journal_title.sql           journal_entries.title
  migrations/0006_sprint5_integrations.sql    google_calendar_connections, oauth_states,
                                               notification_log, profiles.push_subscription
  migrations/0007_pg_cron_daily_checkin.sql   pg_net + pg_cron schedule -> daily-checkin Edge Function
  functions/embed-text/index.ts               gte-small embedding for arbitrary text
  functions/embed-entry/index.ts              Embeds + stores on a specific row's embedding column
  functions/extract-patterns/index.ts         Updates pattern_extractions + typed memories (Groq)
  functions/daily-checkin/index.ts            pg_cron-invoked: decides who needs a notification,
                                               personalizes via Groq, delivers via /api/notifications
public/
  sw.js                                       Web Push service worker (push + notificationclick)
  fonts/poppins-*.woff2                       Bundled Poppins (SIL OFL) for react-pdf generation
```

## Security notes

- The Groq, Tavily, and Google OAuth credentials live only in Vercel's server
  environment (`GROQ_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, no `VITE_` prefix) and are never sent to the
  browser. `VAPID_PRIVATE_KEY` is the same — only `VAPID_PUBLIC_KEY` has a
  `VITE_`-prefixed twin, because the public half of a VAPID key pair is
  meant to reach the browser (it's the Web Push `applicationServerKey`).
- Every table has row-level security scoped to `auth.uid()`, so one account
  can never read or write another account's rows, even via the public anon
  key. Almost all server code — Vercel functions and Edge Functions alike —
  acts through the caller's own JWT, so RLS is the real security boundary,
  not an application-level check.
- **The one exception:** `SUPABASE_SERVICE_ROLE_KEY`
  (`api/_lib/supabaseAdmin.ts` on the Vercel side), used only where there's
  no user session to scope a normal client to, because the request isn't
  user-initiated at all:
  - `api/auth.ts`'s Google callback path — Google's OAuth redirect carries
    no bearer token; it resolves which user via a single-use, opaque
    `state` value (`oauth_states`), not by trusting anything the redirect
    itself claims.
  - `api/notifications.ts`'s trusted path — called by the Supabase
    `daily-checkin` Edge Function (itself invoked by pg_cron on schedule,
    see `supabase/migrations/0007_pg_cron_daily_checkin.sql`), authenticated
    by `CRON_SECRET` rather than a session.
  - `supabase/functions/daily-checkin/index.ts` itself — the piece that
    actually reads across every account to decide who's due for a
    notification. It uses its own `SUPABASE_SERVICE_ROLE_KEY`, which
    Supabase auto-injects into every Edge Function's environment, and
    additionally requires the incoming request's own bearer token to
    literally equal that same key — stricter than Supabase's default
    "any valid project JWT" gate, which would otherwise also accept a
    normal logged-in user's own JWT.

  Every one of these explicitly filters (or, for the Edge Function,
  explicitly authenticates) by the specific identity it's resolved
  through its own narrow mechanism above — none of these clients have an
  RLS safety net, unlike every other Supabase client in this codebase.
  Nothing in the normal user-facing request path (chat, journal, goals,
  profile edits, ...) ever uses it.
- `/api/*` functions require a valid Supabase session token before doing
  anything (the two exceptions above aside), so they can't be used as an
  open proxy.
- Edge Functions require a valid Supabase session JWT (default behaviour) —
  none of them can be called anonymously.
- Web search is never automatic: `/api/search` only runs when the user taps
  "Search" on the confirm bubble the intent classifier triggers. Calendar
  writes are the same shape: `/api/calendar` with `action: 'write'` only
  runs after the user taps "Add to calendar" on the confirm bubble the
  intent classifier's `calendar_event` intent triggers (GUARDRAIL 4) — never
  automatic.
