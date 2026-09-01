import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GROQ_PRIMARY_MODEL, type GroqMessage } from './_lib/groq'
import { analyzeConversation, buildConversationDirective, buildMultiMessageInstruction } from './_lib/conversationAnalyzer'
import {
  generateCandidates,
  rankCandidates,
  scoreTherapySpeak,
  extractPlainText,
  parseMultiMessageJson,
  THERAPY_SPEAK_THRESHOLD,
  CANDIDATE_LETTERS,
  type CandidateLetter,
  type CandidateSet,
} from './_lib/responseRanker'
import { getValidAccessToken, listUpcomingEvents } from './_lib/googleCalendar'
import {
  buildActiveGoalsSummary,
  renderSystemPrompt,
  type ActiveGoalSummary,
  type MemoryBundle,
  type UpcomingCalendarEvent,
  type VectorHit,
} from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile, MemorySummary, ResponseCandidateWinner } from '../src/lib/database.types'

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

// One of the Conversation Engine v1.6 pre-model calls run in parallel
// (see the Promise.all in the handler below) — profile, patterns,
// summaries, and goals are four independent Supabase queries, so they're
// further parallelized against each other here too.
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

// Runs the therapy-speak filter over the ranker's winner, then the other
// two candidates in order, returning the first that scores under
// THERAPY_SPEAK_THRESHOLD. `null` means all three failed the filter.
function pickBestUnderThreshold(winner: CandidateLetter, plainTexts: CandidateSet): CandidateLetter | null {
  const order: CandidateLetter[] = [winner, ...CANDIDATE_LETTERS.filter((letter) => letter !== winner)]
  for (const letter of order) {
    if (scoreTherapySpeak(plainTexts[letter]) < THERAPY_SPEAK_THRESHOLD) return letter
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

    // Conversation Engine v1.6: the analyzer pre-call, the memory/context
    // fetch, the vector search, and the calendar fetch have no dependency
    // on one another, so they run genuinely concurrently — each async
    // function below is invoked (starting it immediately) directly inside
    // the array literal, not awaited one at a time beforehand.
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

    // TEMP DEBUG (Conversation Engine production verification) — remove once confirmed.
    console.log('ANALYZER RESULT:', JSON.stringify(analysis))

    stage = 'insert_user_message'
    const { data: insertedMessage } = await supabase
      .from('chat_history')
      .insert({
        user_id: user.id,
        role: 'user',
        content: latestUserMessage.content,
        embedding: vectorSearchResult.embedding,
      })
      .select('id')
      .single()
    const userMessageId: string | null = insertedMessage?.id ?? null

    stage = 'build_system_prompt'
    const bundle: MemoryBundle = {
      profile: memoryContext.profile,
      patterns: memoryContext.patterns,
      summaries: memoryContext.summaries,
      vectorHits: vectorSearchResult.vectorHits,
      activeGoals: memoryContext.activeGoals,
      upcomingEvents,
    }

    const { prompt: systemPrompt } = renderSystemPrompt(bundle)
    // TEMP DEBUG (Conversation Engine production verification) — remove once confirmed.
    console.log('SYSTEM PROMPT (first 500 chars):', systemPrompt.slice(0, 500))

    const groqMessages: GroqMessage[] = [{ role: 'system', content: systemPrompt }]
    if (body.searchContext) {
      groqMessages.push({
        role: 'system',
        content: `<search_results>\n${body.searchContext}\n</search_results>`,
      })
    }

    const directive = buildConversationDirective(analysis)
    // TEMP DEBUG (Conversation Engine production verification) — remove once confirmed.
    console.log('DIRECTIVE:', directive)

    groqMessages.push({ role: 'system', content: directive })
    if (analysis.multi_message) {
      groqMessages.push({ role: 'system', content: buildMultiMessageInstruction(analysis) })
    }
    groqMessages.push(...body.messages)

    const candidateMaxTokens = analysis.multi_message ? 500 : 800

    stage = 'generate_candidates'
    let candidates: CandidateSet
    try {
      candidates = await generateCandidates(apiKey, groqMessages, analysis.multi_message, candidateMaxTokens)
    } catch (err) {
      console.error('chat failed at stage "generate_candidates"', err)
      res.status(502).json({ error: 'Groq API request failed', detail: String(err) })
      return
    }

    const plainTexts: CandidateSet = {
      A: extractPlainText(candidates.A, analysis.multi_message),
      B: extractPlainText(candidates.B, analysis.multi_message),
      C: extractPlainText(candidates.C, analysis.multi_message),
    }

    stage = 'rank_candidates'
    const { winner, reason: rankerReason } = await rankCandidates(apiKey, directive, plainTexts)
    // TEMP DEBUG (Conversation Engine production verification) — remove once confirmed.
    console.log('RANKER RESULT:', JSON.stringify({ winner, reason: rankerReason }))

    stage = 'therapy_speak_filter'
    let finalRaw: string
    let finalPlain: string
    let winnerColumn: ResponseCandidateWinner
    const passedLetter = pickBestUnderThreshold(winner, plainTexts)
    if (passedLetter) {
      finalRaw = candidates[passedLetter]
      finalPlain = plainTexts[passedLetter]
      winnerColumn = passedLetter
    } else {
      // All three candidates read as too therapeutic — regenerate once
      // with a stronger directive rather than sending a clinical reply.
      console.error('chat: all 3 candidates scored >= therapy-speak threshold, regenerating once', {
        scores: { A: scoreTherapySpeak(plainTexts.A), B: scoreTherapySpeak(plainTexts.B), C: scoreTherapySpeak(plainTexts.C) },
      })
      try {
        finalRaw = await callGroq(apiKey, {
          model: GROQ_PRIMARY_MODEL,
          jsonMode: analysis.multi_message,
          maxTokens: candidateMaxTokens,
          temperature: 0.85,
          messages: [...groqMessages, { role: 'system', content: TOO_THERAPEUTIC_DIRECTIVE }],
        })
      } catch (err) {
        console.error('chat failed at stage "therapy_speak_filter" (regeneration)', err)
        res.status(502).json({ error: 'Groq API request failed', detail: String(err) })
        return
      }
      finalPlain = extractPlainText(finalRaw, analysis.multi_message)
      winnerColumn = 'REGENERATED'
      const regeneratedScore = scoreTherapySpeak(finalPlain)
      if (regeneratedScore >= THERAPY_SPEAK_THRESHOLD) {
        console.error('chat: regenerated response also scored >= therapy-speak threshold', { score: regeneratedScore })
      }
    }

    stage = 'persist_and_respond'
    const persistPromises: PromiseLike<unknown>[] = [
      supabase.from('chat_history').insert({ user_id: user.id, role: 'assistant', content: finalPlain }),
      supabase.functions.invoke('extract-patterns', {
        body: { userId: user.id, content: latestUserMessage.content },
      }),
    ]
    if (userMessageId) {
      persistPromises.push(
        supabase.from('response_candidates').insert({
          user_id: user.id,
          message_id: userMessageId,
          candidate_a: candidates.A,
          candidate_b: candidates.B,
          candidate_c: candidates.C,
          winner: winnerColumn,
          ranker_reason: rankerReason,
        }),
      )
    }
    await Promise.allSettled(persistPromises)

    if (analysis.multi_message) {
      res.status(200).json({ messages: parseMultiMessageJson(finalRaw) })
      return
    }

    // Non-streaming generation is the point of the candidate/ranker
    // pipeline above — there's no token-by-token Groq stream for a
    // response that's already been fully generated three times over by
    // the time a winner is picked. The client still reads this the same
    // way it always has (a chunked text/plain body via a stream reader),
    // it just now arrives as a single chunk instead of many.
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
