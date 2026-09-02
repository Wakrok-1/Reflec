import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGemini, type GeminiMessage } from './_lib/gemini'
import { analyzeConversation, buildConversationDirective, buildMultiMessageInstruction } from './_lib/conversationAnalyzer'
import {
  parseMultiMessageJson,
  extractPlainText,
  scoreTherapySpeak,
  isAutoRejectedTherapySpeak,
  THERAPY_SPEAK_THRESHOLD,
} from './_lib/responseQuality'
import { getValidAccessToken, listUpcomingEvents } from './_lib/googleCalendar'
import {
  buildActiveGoalsSummary,
  renderSystemPrompt,
  type ActiveGoalSummary,
  type MemoryBundle,
  type UpcomingCalendarEvent,
  type VectorHit,
} from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile, MemorySummary, SelfConcept } from '../src/lib/database.types'

interface ChatRequestBody {
  messages?: GeminiMessage[]
  userId?: string
  // Pre-fetched Tavily results the user explicitly confirmed via the
  // search confirm bubble (PRD 5.3) — never populated automatically.
  searchContext?: string
}

const VECTOR_HITS_PER_SOURCE = 5
const VECTOR_HITS_TOTAL = 5

const TOO_THERAPEUTIC_DIRECTIVE =
  'Previous response was too therapeutic. Respond more directly. Do not describe their emotion back to them.'

// Reflection feature (PRD v1.6 Part 2) — an explicit request, not an
// inferred one. "reflect me" / "bayangan diri aku" (Malay) / "show my
// reflection" all mean the same thing: stop the normal conversational
// turn and synthesise a portrait instead.
const REFLECTION_TRIGGER_PATTERNS = [/reflect me/i, /bayangan diri aku/i, /show my reflection/i]

function isReflectionTrigger(text: string): boolean {
  return REFLECTION_TRIGGER_PATTERNS.some((pattern) => pattern.test(text))
}

const REFLECTION_MODE_DIRECTIVE = `The user just explicitly asked to be reflected back — REFLECTION MODE is active for this response only.

Synthesise everything you know about them into one specific, honest mirror:
- Who they have been across time (declared_self + identity_evolution in <self_concept>)
- How they've changed (identity_evolution, the observed patterns in <self_concept>)
- What tensions exist in their self-concept (identity_tensions)
- What you've learned about how to talk to them (interaction_memory, response_preference)

Write in second person. Be specific — use their own words and patterns as evidence, not generic affirmations. No therapy-speak, no clinical voice — this is [EXAMPLES]'s voice, just given more room to breathe. This is the one moment a longer response is earned; do not pad it, but do not rush it either.`

type ScopedSupabase = ReturnType<typeof createUserScopedClient>

interface MemoryContextResult {
  profile: Profile | null
  profileError: unknown
  patterns: PatternExtraction | null
  summaries: MemorySummary[]
  activeGoals: ActiveGoalSummary[]
  selfConcept: SelfConcept | null
}

// One of the Conversation Engine's pre-model calls run in parallel (see
// the Promise.all in the handler below) — profile, patterns, summaries,
// goals, and self_concept are five independent Supabase queries, so
// they're further parallelized against each other here too. Pure
// Supabase reads, no model calls, so none of this counts against any
// provider's rate limit.
async function fetchMemoryContext(supabase: ScopedSupabase, userId: string): Promise<MemoryContextResult> {
  const [
    { data: profile, error: profileError },
    { data: patterns },
    { data: summaries },
    { data: goalRows },
    { data: selfConcept },
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase.from('pattern_extractions').select('*').eq('user_id', userId).maybeSingle(),
    supabase
      .from('memory_summaries')
      .select('*')
      .eq('user_id', userId)
      .order('period_end', { ascending: false })
      .limit(20),
    supabase.from('goals').select('*').eq('user_id', userId).in('type', ['big_goal', 'increment']),
    supabase.from('self_concept').select('*').eq('user_id', userId).maybeSingle(),
  ])

  return {
    profile: (profile as Profile) ?? null,
    profileError,
    patterns: (patterns as PatternExtraction) ?? null,
    summaries: summaries ?? [],
    activeGoals: buildActiveGoalsSummary(goalRows ?? []),
    selfConcept: (selfConcept as SelfConcept) ?? null,
  }
}

// Fully optional and never allowed to break chat: an expired/revoked
// Google token, a Calendar API hiccup, or simply never having connected
// all resolve to "omit the <calendar> block" (7.2 / 6.2).
async function fetchCalendarEvents(
  supabase: ScopedSupabase,
  userId: string,
): Promise<UpcomingCalendarEvent[] | undefined> {
  try {
    const connection = await getValidAccessToken(supabase, userId)
    if (!connection) return undefined
    return await listUpcomingEvents(connection.accessToken, connection.calendarId)
  } catch (err) {
    console.error('chat: calendar fetch failed, continuing without it', err)
    return undefined
  }
}

interface VectorSearchResult {
  embedding: number[] | null
  vectorHits: VectorHit[]
}

// Embeds the new message once, up front: this exact embedding is both
// (a) the query vector for this request's semantic search, and (b) what
// gets stored on the chat_history row — no reason to compute it twice.
// The embed-text call is a Supabase Edge Function invocation, not a model
// call, so it's safe to run alongside the other pre-model branches too.
async function runVectorSearch(
  supabase: ScopedSupabase,
  userId: string,
  messageContent: string,
): Promise<VectorSearchResult> {
  const { data: embedData } = await supabase.functions.invoke<{ embedding: number[] }>('embed-text', {
    body: { text: messageContent },
  })
  const embedding = embedData?.embedding ?? null
  if (!embedding) return { embedding: null, vectorHits: [] }

  const [journalHits, chatHits] = await Promise.all([
    supabase.rpc('match_journal_entries', {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: VECTOR_HITS_PER_SOURCE,
    }),
    supabase.rpc('match_chat_history', {
      query_embedding: embedding,
      match_user_id: userId,
      match_count: VECTOR_HITS_PER_SOURCE,
    }),
  ])

  const combined: VectorHit[] = [
    ...(journalHits.data ?? []).map(
      (h: { content: string; created_at: string; similarity: number }): VectorHit => ({
        content: h.content,
        created_at: h.created_at,
        similarity: h.similarity,
        source: 'journal_entries',
      }),
    ),
    ...(chatHits.data ?? []).map(
      (h: { content: string; created_at: string; similarity: number }): VectorHit => ({
        content: h.content,
        created_at: h.created_at,
        similarity: h.similarity,
        source: 'chat_history',
      }),
    ),
  ]
  const vectorHits = combined.sort((a, b) => b.similarity - a.similarity).slice(0, VECTOR_HITS_TOTAL)
  return { embedding, vectorHits }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Tracks which step was in flight when something throws, so Vercel's logs
  // say *where* chat failed instead of just "chat failed" — the difference
  // between "auth is broken" and "a model provider is down" at a glance.
  let stage = 'start'

  try {
    stage = 'verify_user'
    const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const user = await verifyUser(req.headers.authorization)
    if (!user || !accessToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    stage = 'parse_body'
    const body = req.body as ChatRequestBody
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: '"messages" must be a non-empty array' })
      return
    }
    if (body.userId && body.userId !== user.id) {
      res.status(403).json({ error: 'userId does not match the authenticated session' })
      return
    }

    // Two model providers now: the conversation analyzer stays on Groq
    // (openai/gpt-oss-20b — fast, cheap, well within its own free-tier
    // budget), while the main response moved to Gemini (see
    // api/_lib/gemini.ts for why). Both keys are checked up front so a
    // missing one fails clearly here instead of deep inside a provider
    // call with a generic error.
    stage = 'check_api_keys'
    const groqApiKey = process.env.GROQ_API_KEY
    if (!groqApiKey) {
      console.error('chat failed at stage "check_api_keys": GROQ_API_KEY is not set in this environment')
      res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
      return
    }
    if (!process.env.GOOGLE_AI_API_KEY) {
      console.error('chat failed at stage "check_api_keys": GOOGLE_AI_API_KEY is not set in this environment')
      res.status(500).json({ error: 'GOOGLE_AI_API_KEY is not configured on the server' })
      return
    }

    const latestUserMessage = [...body.messages].reverse().find((m) => m.role === 'user')
    if (!latestUserMessage) {
      res.status(400).json({ error: 'messages must contain at least one user turn' })
      return
    }

    stage = 'create_scoped_client'
    const supabase = createUserScopedClient(accessToken)

    // The analyzer (1 Groq call), memory/context fetch, vector search,
    // and calendar fetch have no dependency on one another, so they run
    // genuinely concurrently — each async function below is invoked
    // (starting it immediately) directly inside the array literal, not
    // awaited one at a time beforehand.
    stage = 'parallel_pre_model'
    const [analysis, memoryContext, upcomingEvents, vectorSearchResult] = await Promise.all([
      analyzeConversation(groqApiKey, body.messages.slice(-8)),
      fetchMemoryContext(supabase, user.id),
      fetchCalendarEvents(supabase, user.id),
      runVectorSearch(supabase, user.id, latestUserMessage.content),
    ])

    if (memoryContext.profileError || !memoryContext.profile) {
      console.error('chat failed at stage "parallel_pre_model": no profile row for this user', memoryContext.profileError)
      res.status(500).json({ error: 'Could not load user profile' })
      return
    }

    stage = 'insert_user_message'
    await supabase.from('chat_history').insert({
      user_id: user.id,
      role: 'user',
      content: latestUserMessage.content,
      embedding: vectorSearchResult.embedding,
    })

    stage = 'build_system_prompt'
    const bundle: MemoryBundle = {
      profile: memoryContext.profile,
      patterns: memoryContext.patterns,
      summaries: memoryContext.summaries,
      vectorHits: vectorSearchResult.vectorHits,
      activeGoals: memoryContext.activeGoals,
      upcomingEvents,
      selfConcept: memoryContext.selfConcept,
    }

    const { prompt: systemPromptBase } = renderSystemPrompt(bundle)

    const reflectionRequested = isReflectionTrigger(latestUserMessage.content)
    if (reflectionRequested) {
      // A portrait is one long message, not a back-and-forth burst —
      // override whatever the analyzer decided for this one turn.
      analysis.multi_message = false
    }

    // Gemini takes the system prompt out of band (systemInstruction, see
    // api/_lib/gemini.ts) rather than as a message in the conversation
    // list the way Groq's system-role messages worked — every piece that
    // used to be a separate system message (search context, the
    // conversational directive, the multi-message instruction, the
    // reflection directive) is folded into one system prompt string
    // instead.
    const systemPromptParts = [systemPromptBase]
    if (body.searchContext) {
      systemPromptParts.push(`<search_results>\n${body.searchContext}\n</search_results>`)
    }
    systemPromptParts.push(buildConversationDirective(analysis))
    if (analysis.multi_message) {
      systemPromptParts.push(buildMultiMessageInstruction(analysis))
    }
    if (reflectionRequested) {
      systemPromptParts.push(REFLECTION_MODE_DIRECTIVE)
    }
    const geminiSystemPrompt = systemPromptParts.join('\n\n')
    const conversationMessages: GeminiMessage[] = body.messages

    // These budgets were originally sized tight for Groq's 8,000 TPM
    // free-tier ceiling — 800 for a normal reply visibly wasn't enough
    // (confirmed in production: a reply cut off mid-sentence, finishReason
    // MAX_TOKENS). Gemini's free tier isn't token-scarce the same way, so
    // there's no longer a reason to keep these this tight.
    const responseMaxTokens = reflectionRequested ? 2000 : analysis.multi_message ? 700 : 1500

    // Single main-model call (PRD v1.6). Gemini's 1M token
    // context and generous free tier are why this moved off Groq — the
    // 8,000 TPM ceiling there was structurally too small for this app's
    // injected context (system prompt alone is ~2,880 tokens), not
    // something per-section trimming could fix.
    stage = 'call_main_model'
    let raw: string
    try {
      raw = await callGemini({
        systemPrompt: geminiSystemPrompt,
        messages: conversationMessages,
        maxTokens: responseMaxTokens,
        temperature: 0.85,
        jsonMode: analysis.multi_message,
      })
    } catch (err) {
      console.error('chat failed at stage "call_main_model"', err)
      res.status(502).json({ error: 'Gemini API request failed', detail: String(err) })
      return
    }

    // Therapy-speak post-filter (PRD v1.6): plain string scoring, no
    // extra model call. A response regenerates once if either its point
    // score hits THERAPY_SPEAK_THRESHOLD, OR it opens with "I hear"/"I
    // can hear"/"I'm hearing" — that opener is an automatic reject that
    // bypasses the point system entirely, since at only 3 points it
    // wasn't enough on its own to cross the 4-point threshold and kept
    // slipping through in production. The common case is still one call
    // in, one response out.
    stage = 'therapy_speak_filter'
    let finalRaw = raw
    let finalPlain = extractPlainText(raw, analysis.multi_message)
    let therapySpeakScore = scoreTherapySpeak(finalPlain)
    let autoRejected = isAutoRejectedTherapySpeak(finalPlain)
    let regenerated = false

    if (therapySpeakScore >= THERAPY_SPEAK_THRESHOLD || autoRejected) {
      console.error('chat: response failed therapy-speak filter, regenerating once', {
        score: therapySpeakScore,
        autoRejected,
      })
      try {
        const regeneratedRaw = await callGemini({
          systemPrompt: `${geminiSystemPrompt}\n\n${TOO_THERAPEUTIC_DIRECTIVE}`,
          messages: conversationMessages,
          maxTokens: responseMaxTokens,
          temperature: 0.85,
          jsonMode: analysis.multi_message,
        })
        finalRaw = regeneratedRaw
        finalPlain = extractPlainText(finalRaw, analysis.multi_message)
        therapySpeakScore = scoreTherapySpeak(finalPlain)
        autoRejected = isAutoRejectedTherapySpeak(finalPlain)
        regenerated = true
      } catch (err) {
        // Regeneration is a quality improvement on top of an already-
        // working reply, not a required step — the original response
        // (raw/finalPlain as already computed above) is real and
        // coherent, just flagged by the filter as too clinical. Send it
        // instead of turning a working turn into an error page.
        console.error(
          'chat: therapy_speak_filter regeneration failed, sending the original (filter-flagged) response instead of failing the turn',
          err,
        )
      }
      // Only worth a second log line if a regeneration actually happened
      // and still failed the filter.
      if (regenerated && (therapySpeakScore >= THERAPY_SPEAK_THRESHOLD || autoRejected)) {
        console.error('chat: regenerated response also failed the therapy-speak filter', {
          score: therapySpeakScore,
          autoRejected,
        })
      }
    }

    stage = 'persist_and_respond'
    const [assistantInsert] = await Promise.allSettled([
      supabase
        .from('chat_history')
        .insert({ user_id: user.id, role: 'assistant', content: finalPlain })
        .select('id')
        .single(),
      supabase.functions.invoke('extract-patterns', {
        body: { userId: user.id, content: latestUserMessage.content },
      }),
      // Fine-tuning-dataset preference signal (PRD v1.6): the response
      // actually sent, its therapy-speak score, and whether it took a
      // regeneration to get there.
      supabase.from('response_quality_log').insert({
        user_id: user.id,
        response_text: finalPlain,
        therapy_speak_score: therapySpeakScore,
        regenerated,
      }),
    ])

    // Handed back to the client so a later "this felt right" tap
    // (Chat.tsx's markFeltRight) can record response_signals.chat_message_id
    // against the exact response it's reacting to — self_concept's
    // interaction_memory (PRD v1.6 Part 2) reads that link back out.
    const assistantMessageId =
      assistantInsert.status === 'fulfilled'
        ? ((assistantInsert.value as { data?: { id?: string } }).data?.id ?? undefined)
        : undefined

    if (analysis.multi_message) {
      res.status(200).json({ messages: parseMultiMessageJson(finalRaw), assistantMessageId })
      return
    }

    // Non-streaming from Gemini — the therapy-speak filter has to see the
    // full response before deciding whether to regenerate, so there's no
    // safe point to relay partial tokens straight through. The client
    // still reads this the same way it always has (a chunked text/plain
    // body via a stream reader), it just arrives as a single chunk.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    if (assistantMessageId) {
      res.setHeader('X-Message-Id', assistantMessageId)
    }
    res.write(finalPlain)
    res.end()
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's or
    // createUserScopedClient's Supabase client to throw, a network
    // hiccup, etc.) must still come back as JSON — an uncaught throw here
    // becomes Vercel's own plain-text crash page, which breaks every
    // client-side `response.json()` call. If the response has already
    // started streaming, headers are sent and we can only end it cleanly.
    const detail =
      err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { message: String(err) }
    console.error(`chat failed at stage "${stage}"`, detail)
    if (res.headersSent) {
      res.end()
    } else {
      res.status(500).json({ error: 'Unexpected server error', stage, detail: detail.message })
    }
  }
}
