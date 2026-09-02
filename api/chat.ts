import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GroqError, GROQ_PRIMARY_MODEL, type GroqMessage } from './_lib/groq'
import {
  analyzeConversation,
  buildConversationDirective,
  buildMultiMessageInstruction,
  type ConversationAnalysis,
} from './_lib/conversationAnalyzer'
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
  estimateTokens,
  type ActiveGoalSummary,
  type MemoryBundle,
  type UpcomingCalendarEvent,
  type VectorHit,
} from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile, MemorySummary } from '../src/lib/database.types'

interface ChatRequestBody {
  messages?: GroqMessage[]
  userId?: string
  // Pre-fetched Tavily results the user explicitly confirmed via the
  // search confirm bubble (PRD 5.3) — never populated automatically.
  searchContext?: string
}

const VECTOR_HITS_PER_SOURCE = 5
const VECTOR_HITS_TOTAL = 5

const TOO_THERAPEUTIC_DIRECTIVE =
  'Previous response was too therapeutic. Respond more directly. Do not describe their emotion back to them.'

type ScopedSupabase = ReturnType<typeof createUserScopedClient>

interface MemoryContextResult {
  profile: Profile | null
  profileError: unknown
  patterns: PatternExtraction | null
  summaries: MemorySummary[]
  activeGoals: ActiveGoalSummary[]
}

// One of the Conversation Engine's pre-model calls run in parallel (see
// the Promise.all in the handler below) — profile, patterns, summaries,
// and goals are four independent Supabase queries, so they're further
// parallelized against each other here too. Pure Supabase reads, no Groq
// calls, so none of this counts against the Groq free-tier rate limit.
async function fetchMemoryContext(supabase: ScopedSupabase, userId: string): Promise<MemoryContextResult> {
  const [{ data: profile, error: profileError }, { data: patterns }, { data: summaries }, { data: goalRows }] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('pattern_extractions').select('*').eq('user_id', userId).maybeSingle(),
      supabase
        .from('memory_summaries')
        .select('*')
        .eq('user_id', userId)
        .order('period_end', { ascending: false })
        .limit(20),
      supabase.from('goals').select('*').eq('user_id', userId).in('type', ['big_goal', 'increment']),
    ])

  return {
    profile: (profile as Profile) ?? null,
    profileError,
    patterns: (patterns as PatternExtraction) ?? null,
    summaries: summaries ?? [],
    activeGoals: buildActiveGoalsSummary(goalRows ?? []),
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
// The embed-text call is a Supabase Edge Function invocation, not a Groq
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

// gpt-oss sometimes ignores the multi-message JSON-array instruction and
// just writes a normal reply instead of {"messages": [...]} — Groq's
// response_format: json_object then rejects it with a 400
// json_validate_failed, but the error body still hands back the model's
// actual generated text via failed_generation. Salvaging that instead of
// failing the whole turn means the user still gets a real, on-topic
// response — just one bubble instead of several. Mutates
// analysis.multi_message to false so every step downstream of this call
// (plain-text extraction, therapy-speak scoring, the final response
// shape) treats the rest of this turn as single-message.
function salvageFailedGeneration(err: unknown, analysis: ConversationAnalysis, logContext: string): string | null {
  if (err instanceof GroqError && err.failedGeneration && err.failedGeneration.trim().length > 0) {
    console.error(`chat: ${logContext} failed JSON validation, salvaging failed_generation as a single message`, err.detail)
    analysis.multi_message = false
    return err.failedGeneration
  }
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Tracks which step was in flight when something throws, so Vercel's logs
  // say *where* chat failed instead of just "chat failed" — the difference
  // between "auth is broken" and "Groq is down" at a glance.
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

    stage = 'check_groq_key'
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      console.error('chat failed at stage "check_groq_key": GROQ_API_KEY is not set in this environment')
      res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
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
    // awaited one at a time beforehand. Running the analyzer inside this
    // same Promise.all doesn't add any Groq calls beyond the one it was
    // always going to make; only the memory/vector/calendar branches are
    // "free" to parallelize in the rate-limit sense, since those are
    // Supabase calls.
    stage = 'parallel_pre_model'
    const [analysis, memoryContext, upcomingEvents, vectorSearchResult] = await Promise.all([
      analyzeConversation(apiKey, body.messages.slice(-8)),
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
    }

    const { prompt: systemPrompt, breakdown } = renderSystemPrompt(bundle)

    const groqMessages: GroqMessage[] = [{ role: 'system', content: systemPrompt }]
    if (body.searchContext) {
      groqMessages.push({
        role: 'system',
        content: `<search_results>\n${body.searchContext}\n</search_results>`,
      })
    }

    const directive = buildConversationDirective(analysis)
    groqMessages.push({ role: 'system', content: directive })
    if (analysis.multi_message) {
      groqMessages.push({ role: 'system', content: buildMultiMessageInstruction(analysis) })
    }
    groqMessages.push(...body.messages)

    // TEMP DEBUG (context token budget investigation) — Groq's 8,000 TPM
    // free-tier limit was being hit on the very first call_main_model
    // request. Logs every injected section's estimated size so production
    // traffic shows which section(s) actually drive total prompt size,
    // rather than guessing. Remove once the 429s are confirmed gone.
    const systemPromptTokens = estimateTokens(systemPrompt)
    const conversationHistoryTokens = body.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    const totalTokens = groqMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    console.log('TEMP DEBUG context token budget', {
      profile_tokens: breakdown.profile_tokens,
      patterns_tokens: breakdown.patterns_tokens,
      taste_tokens: breakdown.taste_tokens,
      summaries_tokens: breakdown.summaries_tokens,
      vector_hits_tokens: breakdown.vector_hits_tokens,
      goals_tokens: breakdown.goals_tokens,
      calendar_tokens: breakdown.calendar_tokens,
      system_prompt_tokens: systemPromptTokens,
      conversation_history_tokens: conversationHistoryTokens,
      total_tokens: totalTokens,
    })

    const responseMaxTokens = analysis.multi_message ? 500 : 800

    // Single main-model call (PRD v1.6, revised) — the Groq free tier's
    // 1,000-requests/day cap means this stays at exactly one call here
    // (plus the one analyzer call above), not the three parallel
    // candidates + ranker call an earlier version of this pipeline used.
    //
    // disableFallback: true — this request already made one gpt-oss-20b
    // call (the analyzer, above, in the same Promise.all). If this
    // gpt-oss-120b call 429s, callGroq's default behavior would retry
    // against gpt-oss-20b — the same pool the analyzer just drew from —
    // which can immediately 429 again rather than actually recovering.
    // Fail with the original 429 instead of compounding it.
    //
    // reasoningEffort: 'low' — the same gpt-oss "reasoning burns the
    // whole token budget, content ends up empty" failure mode that hit
    // the analyzer (fixed there earlier) also hits the main model on the
    // multi-message JSON path: a 400 json_validate_failed with
    // failed_generation: "" — no prose to salvage, because the model
    // never got past its own internal chain-of-thought to write anything
    // into the answer channel at all. This wasn't applied here originally
    // (kept off deliberately, on the theory a conversational reply might
    // benefit from more deliberation than a mechanical classifier) —
    // but a response that hard-fails is worse than one reasoned a little
    // less deeply, and 'low' doesn't reduce the model's capability to
    // write in character, only how much it deliberates before doing so.
    stage = 'call_main_model'
    let raw: string
    try {
      raw = await callGroq(apiKey, {
        model: GROQ_PRIMARY_MODEL,
        jsonMode: analysis.multi_message,
        maxTokens: responseMaxTokens,
        temperature: 0.85,
        reasoningEffort: 'low',
        disableFallback: true,
        messages: groqMessages,
      })
    } catch (err) {
      // Groq's 429 error text names a specific retry-after duration for
      // this TPM window (observed: "try again in 6.855s") — a single
      // 7-second wait then one retry is cheap relative to Vercel's
      // function timeout and turns a hard failure into a slow-but-working
      // turn for the common "just over the limit" case, without the
      // fallback-cascade risk disableFallback above already guards against.
      if (err instanceof GroqError && err.status === 429) {
        console.error('chat: call_main_model hit 429, waiting 7s and retrying once', err.detail)
        await new Promise((resolve) => setTimeout(resolve, 7000))
        try {
          raw = await callGroq(apiKey, {
            model: GROQ_PRIMARY_MODEL,
            jsonMode: analysis.multi_message,
            maxTokens: responseMaxTokens,
            temperature: 0.85,
            reasoningEffort: 'low',
            disableFallback: true,
            messages: groqMessages,
          })
        } catch (retryErr) {
          const salvaged = salvageFailedGeneration(retryErr, analysis, 'call_main_model retry')
          if (salvaged === null) {
            console.error('chat failed at stage "call_main_model" (after 429 retry)', retryErr)
            res.status(429).json({ error: "Give me a second — I'm a little overloaded right now. Try again in a moment." })
            return
          }
          raw = salvaged
        }
      } else {
        const salvaged = salvageFailedGeneration(err, analysis, 'call_main_model')
        if (salvaged === null) {
          console.error('chat failed at stage "call_main_model"', err)
          res.status(502).json({ error: 'Groq API request failed', detail: String(err) })
          return
        }
        raw = salvaged
      }
    }

    // Therapy-speak post-filter (PRD v1.6): plain string scoring, no
    // extra Groq call. A response regenerates once if either its point
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
        const regeneratedRaw = await callGroq(apiKey, {
          model: GROQ_PRIMARY_MODEL,
          jsonMode: analysis.multi_message,
          maxTokens: responseMaxTokens,
          temperature: 0.85,
          reasoningEffort: 'low',
          disableFallback: true,
          messages: [...groqMessages, { role: 'system', content: TOO_THERAPEUTIC_DIRECTIVE }],
        })
        finalRaw = regeneratedRaw
        finalPlain = extractPlainText(finalRaw, analysis.multi_message)
        therapySpeakScore = scoreTherapySpeak(finalPlain)
        autoRejected = isAutoRejectedTherapySpeak(finalPlain)
        regenerated = true
      } catch (err) {
        const salvaged = salvageFailedGeneration(err, analysis, 'therapy_speak_filter regeneration')
        if (salvaged !== null) {
          finalRaw = salvaged
          finalPlain = extractPlainText(finalRaw, analysis.multi_message)
          therapySpeakScore = scoreTherapySpeak(finalPlain)
          autoRejected = isAutoRejectedTherapySpeak(finalPlain)
          regenerated = true
        } else {
          // Regeneration is a quality improvement on top of an already-
          // working reply, not a required step — the original response
          // (raw/finalPlain as already computed above) is real and
          // coherent, just flagged by the filter as too clinical. If the
          // retry itself fails outright (e.g. a 429 on gpt-oss-120b's own
          // token-per-minute budget, which a same-model regeneration call
          // can trigger on its own without any fallback involved), send
          // the original instead of turning a working turn into an error
          // page. therapySpeakScore/autoRejected/regenerated (still
          // false) are left as-is, so what gets logged and persisted
          // honestly reflects that the flagged original was what shipped.
          console.error(
            'chat: therapy_speak_filter regeneration failed, sending the original (filter-flagged) response instead of failing the turn',
            err,
          )
        }
      }
      // Only worth a second log line if a regeneration actually happened
      // and still failed the filter — the "regeneration errored outright,
      // sent the original instead" case already logged its own reason
      // above, and re-logging the same original score here as if a
      // regenerated response had failed would be misleading.
      if (regenerated && (therapySpeakScore >= THERAPY_SPEAK_THRESHOLD || autoRejected)) {
        console.error('chat: regenerated response also failed the therapy-speak filter', {
          score: therapySpeakScore,
          autoRejected,
        })
      }
    }

    stage = 'persist_and_respond'
    await Promise.allSettled([
      supabase.from('chat_history').insert({ user_id: user.id, role: 'assistant', content: finalPlain }),
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

    if (analysis.multi_message) {
      res.status(200).json({ messages: parseMultiMessageJson(finalRaw) })
      return
    }

    // Non-streaming from Groq — the therapy-speak filter has to see the
    // full response before deciding whether to regenerate, so there's no
    // safe point to relay partial tokens straight through. The client
    // still reads this the same way it always has (a chunked text/plain
    // body via a stream reader), it just arrives as a single chunk.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
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
