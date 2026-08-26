# Your Reflection — Product Requirements Document (v1.5)

> **Provenance note:** this document was reconstructed from the shipped
> codebase (Sprints 0–4) rather than transcribed from an original external
> file — no `your-reflection-PRD-v1.5.md` existed in this repository before
> now, even though comments throughout the code cite it by section number
> (`PRD 5.2`, `PRD 7.2`, `PRD v1.3 section 4`, etc.). Every section number
> below matches a citation that already exists in the code, so existing
> comments continue to point at the right place. Sections describing
> unbuilt work are marked **Planned** rather than presented as delivered.

## 1. Vision

Your Reflection is a personal AI companion — not a generic assistant — that
learns how one person thinks, feels, and grows from their own words:
conversation, journaling, and (eventually) activity data. It carries a
single user's story across sessions and reflects it back to them: their
growth, their patterns, their identity. The product's voice is "the
mirror," never "the assistant."

Core product commitments, unchanged since Sprint 0:

- **One companion, one person.** Every account gets its own memory. Nothing
  is shared, aggregated, or used to train anything else.
- **Their words, not the AI's.** Journaling features restructure and
  format the user's own writing; they never rewrite it into AI prose.
- **Suggest, never impose.** The AI notices things (a trait, a taste, a
  goal worth naming) and surfaces them as suggestions the user explicitly
  accepts or dismisses — it never silently edits what it knows about them.

## 2. Architecture Principles

- **Full multi-user accounts from day one.** Supabase Auth is the source
  of truth for identity; every table carries `user_id` and is protected by
  row-level security so one account can never read or write another's
  data, even via the anon key.
- **No service-role key in the user-facing request path.** Every server-side
  call reachable from something a user does — chat, journal, goals, profile
  edits, calendar read/write — runs scoped to the caller's own JWT. RLS is
  the actual security boundary there, not an application-level check
  layered on top of a privileged key. Sprint 5 introduces the one narrow
  exception: two endpoints with no user session to scope to at all (an
  OAuth redirect callback, and the daily cross-account notification cron)
  use `SUPABASE_SERVICE_ROLE_KEY`, gated by their own mechanism (an opaque
  single-use state token; a `CRON_SECRET` header) rather than a JWT. See
  README "Security notes" for the exact two call sites.
- **`/api/*` functions require a valid session.** They verify the caller's
  Supabase access token before doing anything, so they can never be used
  as an open proxy to Groq, Tavily, or the database.
- **Nothing runs synchronously that doesn't have to (PRD 7.2).** Pattern
  extraction, embedding, and memory-summary jobs are fired and forgotten
  from the request path that triggered them; the user never waits on
  background bookkeeping.

## 3. Stack

| Layer | Choice |
|---|---|
| Frontend | React + Tailwind CSS (Vite) |
| Backend / DB / Auth | Supabase (Postgres + RLS + pgvector + pg_cron) |
| Embeddings | Supabase's built-in `gte-small` (384 dims), via Edge Functions |
| Hosting | Vercel (serverless functions for anything needing a secret) |

## 4. AI Provider (PRD v1.3 section 4)

Groq, chosen for cost and latency over a hosted frontier model for
every-message chat traffic:

- **Primary model:** `openai/gpt-oss-120b` — main chat, pattern extraction,
  onboarding interview and finalization, journal reflection, goal
  suggestions.
- **Fallback model:** `openai/gpt-oss-20b` — used automatically on a 429
  from the primary.
- **Classifier model:** `openai/gpt-oss-20b` — same model as the fallback,
  used here for speed rather than as a fallback path (the intent
  classifier pre-check needs to be fast and cheap, not the most capable
  model).
- **Vision model:** `qwen/qwen3.6-27b` — Apple Journal screenshot OCR.
- Both the Groq and Tavily API keys live only in Vercel's server
  environment (no `VITE_` prefix) and are never sent to the browser.

## 5. Features

### 5.1 Onboarding — the AI interview

The user's first conversation ever. Stateless: the client sends the full
transcript so far, the server returns Your Reflection's next turn. Its
system prompt (`[ONBOARDING MODE]`) instructs the model to learn — not
extract — naturally covering: what to call them, roughly where they are in
life, what they want for themselves, what kind of person they feel they
are, and (once there's enough material) their taste — music, books,
sport/movement, food, hobbies, aesthetics — asking *why* as well as *what*,
so preferences carry emotional context rather than being bare labels. One
question at a time; no checklist rushing. When the user signals they're
done, the transcript is run through a JSON-mode extraction pass (5.1, 7.1)
that produces profile-field and taste-entry suggestions, which the user
approves or dismisses on the Character Profile page (5.1, 7.3) before
anything is written.

### 5.2 Character Profile

A 1:1 extension of the account (`profiles` table): name, age, a
self-defined "class" (an archetype the user names for themselves —
Survivor, Builder, Dreamer, whatever fits, never assigned by the app),
unique strengths, personal philosophy, core values, and a Taste Profile
grouped by category (music, books, sport, food, aesthetics, hobbies,
recurring symbols). Every field is directly editable inline, and every
AI-noticed addition arrives as a suggestion bubble first — the profile
never updates itself silently (GUARDRAIL 3). Taste learned during
onboarding is written directly rather than gated behind a bubble (PRD 5.2:
"the user never fills a form"); suggestion bubbles for taste are reserved
for what the AI notices later, in ongoing chat and journaling.

### 5.3 Chat Core

The main interface. Every message flows through:

1. **Intent classification** — a cheap, fast pre-check (`gpt-oss-20b`)
   tags the message `on_topic`, `off_topic`, `search_needed`, or (Sprint 5)
   `calendar_event` before it reaches the main model. Off-topic messages
   get a warm, human redirect and never reach the personality model at all
   — Your Reflection is not a coding assistant, math tutor, or general
   knowledge engine (GUARDRAIL 7).
2. **Web search — confirm bubble.** If the classifier detects the message
   needs current information, the client shows a confirm/skip bubble; a
   Tavily search only runs on the user's explicit tap, never
   automatically.
3. **Calendar write — confirm bubble (Sprint 5).** If the classifier
   resolves a concrete date/time from the message, the client shows the
   same shape of confirm/skip bubble; `/api/calendar-write` only runs on
   the user's explicit tap (GUARDRAIL 4 — never silent), and the AI
   confirms in chat: "Added to your calendar — [title] on [date] at
   [time]." This exchange is ephemeral (never sent to the model, never
   persisted to `chat_history`) — it's a utility action, not a moment of
   conversation.
4. **Memory-injected, streamed reply.** The full memory bundle (7.2) is
   rendered into the system prompt and streamed token-by-token from Groq
   back to the client.
5. **"Felt right" signal.** The user can mark any assistant reply as
   having landed — a lightweight positive signal stored for future pattern
   analysis, with no negative equivalent (silence is the negative signal).

### 5.4 Journal

Two entry modes:

- **Snap Mode** — no title, no word count, no formatting pressure. A
  one-tap capture for a passing thought; tagging and embedding happen
  quietly in the background.
- **Full Journal** — a real entry with an optional title, optional AI
  reflection (specific to what was written, skippable, never generic), and
  optional import from an Apple Journal screenshot (6.4).

Entries move between modes without losing the user's own words:
**"Turn into journal"** restructures a day's snaps into one entry, and
**"Distill to snap"** pulls a full entry's one-line essence — in both
directions, the app restructures and formats, it does not rewrite
(GUARDRAIL 5). Either entry type can be marked private, which excludes it
from all memory extraction, pattern analysis, and the PDF export builder.

**PDF Export Builder** (Sprint 3): a canvas of typed blocks (quote,
journal entry, snap collection, goal of the day, AI journal prompt, photo,
mood indicator, divider) built from a date range of the user's own
entries, freely reordered and edited, rendered to a real PDF (Minimal or
Editorial style, A4 or A5) via `@react-pdf/renderer`.

### 5.5 Goals — Big Life Goals, Increments, Bucket List (Sprint 4)

Three sections on one Goals page:

- **Big Life Goals + Increments** — a goal is a card with a title,
  optional description, and an expandable checklist of small, concrete
  increments. Checking off an increment recomputes the goal's progress
  percentage automatically; reaching 100% completed increments retires the
  goal to the Achievements page as a medal. Titles and increments are
  editable inline; the AI can propose a goal (with increments) via the
  suggestion-bubble flow, always pending the user's approval.
- **Bucket List** — a flat list of life experiences the user wants to
  have. Checked items are marked done, not deleted. The AI can propose
  bucket-list items grounded in the user's taste profile and recurring
  themes, again via suggestion bubbles.
- **Personal Philosophy** — a single text block synced with the same
  `philosophy` field shown on the Character Profile page; either page
  edits the same source of truth.

An active goal's progress is not siloed to the Goals page: the context
builder injects a live `<active_goals>` summary into chat's memory bundle
(7.2), so the AI can reference goal progress naturally in conversation,
and the PDF export builder's "Goal of the day" block pulls the
most-recently-active goal (including recent increment check-offs) by
default, with a picker to show a different one.

### 5.6 Suggestions *(Planned)*

A `suggestions` table exists (categories: book, music, habit, experience,
food, journal prompt; weekly/monthly cycle) for a dedicated page where the
AI surfaces a periodic batch of recommendations the user can act on, save,
or dismiss as "not for me." Schema is in place; no page consumes it yet.
Not to be confused with the suggestion-bubble *mechanism* (5.2, 7.3),
which is built and used throughout Character Profile and Goals.

### 5.7 Character Profile — categorized info pills *(Planned)*

A "the organised you" section design, showing profile facets as category
pills (`CategoryPill`). Stubbed in the component library (Section 11 of
the design spec); not yet wired into the Character Profile page.

## 6. Integrations

- **6.2 Google Calendar (Sprint 5)** — built. OAuth (`calendar.events`
  scope, read + write) via `api/google-auth-start.ts` /
  `api/google-callback.ts`; tokens stored per-user in
  `google_calendar_connections`, refreshed automatically on expiry
  (`api/_lib/googleCalendar.ts`). Reads (`api/calendar-read.ts`) power the
  `<calendar>` context block (7.2); writes (`api/calendar-write.ts`) are
  chat-triggered and always confirmed first (GUARDRAIL 4, 5.3). A written
  event also gets a local mirror row in `calendar_events` (`source:
  'chat'`) for the app's own record.
- **6.4 Apple Journal screenshot import** — built. A screenshot upload is
  read by the Groq vision model, OCR'd into editable text the user reviews
  before saving, rather than trusting a blind auto-import.
- **6.1 Strava** — *Explicitly out of scope for Sprint 5.* No OAuth flow,
  sync job, or context injection exists — `strava_data` remains the
  untouched Sprint 0 foundation table. Revisit in a later sprint if
  reintroduced.

## 6a. Web Push Notifications (Sprint 5)

- **Setup:** VAPID key pair (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` server-
  side, `VITE_VAPID_PUBLIC_KEY` — same public value — client-side); a
  service worker (`public/sw.js`) handles `push` and `notificationclick`;
  a subscription (`PushSubscription.toJSON()`) is stored on
  `profiles.push_subscription`. The user is prompted once (dismissible,
  tracked client-side, not a DB column) the first time they land on
  `/chat` without an existing subscription.
- **Notification types:**
  - **Daily check-in** — if the user hasn't had any chat/journal/snap
    activity yet today, a Groq-personalized line referencing their most
    recent entry ("You mentioned feeling anxious about the deadline
    yesterday — how's that going?"), never a generic "Time to journal!"
  - **Goal reminder** — a big goal is flagged overdue when the time since
    its last completed increment exceeds 1.5× that goal's own average
    pace between completions (needs at least 2 completed increments to
    establish a pace — there's no fixed due-date concept here, it's
    entirely relative to how the user has actually been moving).
  - **Suggestion ready** — the preference toggle and delivery plumbing
    exist, but nothing generates weekly suggestions yet (5.6 is still
    Planned), so this type has no automatic trigger today.
- **Delivery:** `api/cron/daily-checkin.ts`, a Vercel Cron job
  (`vercel.json`, daily at 09:00 UTC) gated by `CRON_SECRET`, sweeps every
  account with a stored subscription, checks per-user preferences and
  quiet hours, and sends via `api/_lib/webpush.ts`. `notification_log`
  dedupes so a goal or a day is never double-notified.
- **Known limitation:** quiet hours (`profiles.notification_prefs.quiet_hours_start/end`)
  are compared against the cron's UTC clock — there's no per-user timezone
  stored anywhere yet, so they're only precisely accurate for users near
  UTC. Documented rather than silently wrong.
- **User control:** the Notifications section on `/profile` (5.2) — toggle
  per type, quiet-hours start/end — writes directly to
  `profiles.notification_prefs`.

## 7. AI / Memory Architecture

### 7.1 System Prompt Structure

The chat system prompt is one locked-wording document with named,
explicit sections — `[IDENTITY]`, `[RULES]`, `[MEMORY]`, `[BEHAVIOUR]`,
`[ONBOARDING MODE]`, `[GUARDRAILS]` — because smaller open models respond
more reliably to named rule blocks than to implied prose. Twelve numbered
rules govern tone and response shape (acknowledge feeling first, never
invalidate, no unsolicited advice lists, one question per response, mirror
the user's register, and so on); seven guardrails govern what the AI is
silently forbidden from ever doing (never suggest reconciling with a toxic
ex/family member/betrayer, never update the profile without a suggestion
bubble first, never pivot a struggling user to a hotline and disengage).
Pattern extraction (turning raw conversation into structured
profile/taste/memory suggestions) always runs in Groq's JSON mode with an
explicit schema — never free-text parsing.

### 7.2 Per-Request Context Injection

The `[MEMORY]` block's placeholders are filled per-request from a
`MemoryBundle`: profile + patterns (the fixed "hot" tier, never trimmed),
active goals, recent rolling summaries, and vector search hits — filled in
that priority order against a soft token budget (~2000 tokens, roughly
4 chars/token), so lower tiers are the first to come up short under
pressure rather than the profile ever being cut.

**Hybrid retrieval:** vector search (pgvector HNSW, cosine similarity)
across journal entries and chat history is narrowed first by metadata
filters (user, type, date) before semantic ranking runs on what's left.

**Typed memory entities (new in v1.5):** beyond plain semantic search,
every meaningful fact extracted from journal entries, snaps, and
conversation is stored as a typed, confidence-scored `memories` row
(`EVENT`, `BELIEF`, `GOAL`, `PREFERENCE`, `EMOTION`, `HABIT`,
`ACHIEVEMENT`, `PROBLEM`), each with its own embedding, so retrieval can
filter by type before falling back to pure similarity.

**Job-queue pattern:** embedding and pattern-extraction jobs are invoked
fire-and-forget from whatever request produced new content (a chat
message, a journal entry, a snap) — nothing in the user-facing request
path waits on them.

### 7.3 Suggestion Approval Flow

Every AI-noticed addition to what the app "knows" about the user —
a profile trait, a taste entry, a goal, a bucket-list idea — surfaces as a
suggestion bubble (cream background, sage accent) with Accept/Dismiss.
Dismissed suggestions are fingerprinted and stored (`dismissed_suggestions`)
so the same suggestion is never re-surfaced, even if a later extraction
pass regenerates it. The AI never writes any of this data unprompted
(GUARDRAIL 3) — the user always decides.

## 8. Data Model Notes

- `profiles` — 1:1 extension of `auth.users`; created automatically on
  signup via a Postgres trigger.
- `journal_entries`, `snaps` — the two Journal modes (5.4).
- `goals` — one table, three `type`s (`big_goal`, `increment`,
  `bucket_list`), increments linked to their parent goal by
  `parent_goal_id` (5.5).
- `suggestions` — the *Planned* periodic-recommendation feature (5.6),
  distinct from `dismissed_suggestions` (the suggestion-bubble mechanism's
  do-not-resurface ledger, 7.3).
- `calendar_events` — individual Google Calendar events, written either by
  chat (`source: 'chat'`) or (unbuilt) a future sync job. `strava_data`
  remains an untouched, unused Sprint 0 foundation table (6).
- `google_calendar_connections` — one row per user holding OAuth tokens
  (6.2), deliberately separate from `calendar_events` (one row per
  *event*) so refresh-on-expiry is a single-row update, not a rewrite
  across every event a user has.
- `oauth_states` — short-lived, single-use tokens bridging an OAuth
  redirect (which carries no session) back to the user who started it.
- `notification_log` — dedup ledger so the daily cron never double-sends
  a check-in or a specific goal's reminder on the same day (6a).
- `chat_history`, `memory_summaries`, `taste_profile`,
  `pattern_extractions`, `response_signals` — chat memory substrate (7.2).
- `memories` — typed memory entities, new in v1.5 (7.2).
- `private_entries` — junction table flagging a `journal_entries` or
  `snaps` row as private; excluded from every extraction/analysis job.
  Intentionally has no foreign key (it points into one of two tables
  depending on `entry_type`), so every job anti-joins against it
  explicitly rather than relying on a cascade.

Every table above carries row-level security scoped to `auth.uid()`.

## 9. Sprint History

| Sprint | Scope | Status |
|---|---|---|
| 0 | Foundation: schema, auth, Vercel/Supabase wiring | ✅ Built |
| 1 | Onboarding AI interview + Character Profile | ✅ Built |
| 2 | Chat Core + memory engine (context injection, vector search, patterns) | ✅ Built |
| 3 | Full Journal + PDF Export Builder | ✅ Built |
| 4 | Goals (Big Life Goals, Increments, Bucket List) + Achievements | ✅ Built |
| 5 | Google Calendar (6.2) + Web Push Notifications (6a) | ✅ Built |
| — | Suggestions page (5.6), Category pills (5.7), Strava (6.1) | ⏳ Planned |
