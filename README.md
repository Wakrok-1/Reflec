# Your Reflection

A personal AI companion that learns how you think, feel, and grow — from your
own words, journal entries, and activity data. See the full product spec in
the PRD shared with this repo (v1.5).

**Status:** Sprint 0 (Foundation), Sprint 1 (Onboarding + Character Profile),
Sprint 2 (Chat Core), Sprint 3 (Full Journal + PDF Export), and Sprint 4
(Goals + Achievements) are built. Charts and integrations land in later
sprints.

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
3. Add the four environment variables from `.env` in the Vercel project's
   **Settings → Environment Variables**.
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
  lib/systemPrompt.ts        SYSTEM_PROMPT — the full chat personality (locked wording)
  lib/contextBuilder.ts      Fills SYSTEM_PROMPT's [MEMORY] placeholders under a token budget
  lib/classGradient.ts       Deterministic class badge gradient (design spec §8)
  types/onboarding.ts        Shape of the onboarding extraction JSON
  types/suggestions.ts       Suggestion bubble discriminated union
  lib/exportBlocks.ts        PDF export builder's Block/CanvasConfig data model
  lib/goals.ts                Big Life Goals/Increments/Bucket List data layer + progress math
  pages/                     Login, Signup, AuthCallback, Home, Onboarding,
                             CharacterProfile, Chat, Journal, JournalExport, Goals, Achievements
  components/
    ProtectedRoute.tsx
    SuggestionBubble.tsx      Accept/Dismiss approval bubble (PRD 5.2, 7.3)
    MemoryControls.tsx        "What does my AI know about me?" + mark-private toggles
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
  chat.ts                     Streaming chat: memory injection, vector search, Groq
  classify-intent.ts          gpt-oss-20b pre-check: on_topic / off_topic / search_needed
  search.ts                   Tavily search, only called on explicit user confirmation
  journal-reflect.ts          Optional AI reflection on a full journal entry
  journal-prompt.ts           AI-generated journal prompt for the export builder's prompt block
  turn-into-journal.ts        Restructures a day's snaps into one entry — their words only
  distill-to-snap.ts          Pulls a full entry's one-line essence
  vision-extract.ts           Apple Journal screenshot OCR via qwen/qwen3.6-27b vision
  onboarding-chat.ts          One turn of the AI interview (Groq)
  onboarding-finalize.ts      Extracts profile/taste suggestions (Groq, JSON mode)
  goal-suggest.ts              AI-suggested goal or bucket-list items (Groq, JSON mode)
  groq-test.ts                Server-side Groq connectivity check
  _lib/verifyUser.ts          Verifies the caller's Supabase session
  _lib/supabaseServer.ts      RLS-scoped Supabase client (no service-role key, ever)
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
  functions/embed-text/index.ts               gte-small embedding for arbitrary text
  functions/embed-entry/index.ts              Embeds + stores on a specific row's embedding column
  functions/extract-patterns/index.ts         Updates pattern_extractions + typed memories (Groq)
public/fonts/poppins-*.woff2                  Bundled Poppins (SIL OFL) for react-pdf generation
```

## Security notes

- The Groq and Tavily API keys live only in Vercel's server environment
  (`GROQ_API_KEY`, `TAVILY_API_KEY`, no `VITE_` prefix) and are never sent to
  the browser.
- Every table has row-level security scoped to `auth.uid()`, so one account
  can never read or write another account's rows, even via the public anon
  key. Server code — Vercel functions and Edge Functions alike — never uses
  a service-role key; it always acts through the caller's own JWT, so RLS is
  the real security boundary everywhere, not an application-level check.
- `/api/*` functions require a valid Supabase session token before doing
  anything, so they can't be used as an open proxy.
- Edge Functions require a valid Supabase session JWT (default behaviour) —
  none of them can be called anonymously.
- Web search is never automatic: `/api/search` only runs when the user taps
  "Search" on the confirm bubble the intent classifier triggers.
