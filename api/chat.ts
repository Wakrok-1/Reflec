import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GROQ_PRIMARY_MODEL, parseGroqStreamLine, streamGroq, type GroqMessage } from './_lib/groq'
import { analyzeConversation, buildConversationDirective } from './_lib/conversationAnalyzer'
import { getValidAccessToken, listUpcomingEvents } from './_lib/googleCalendar'
import {
  buildActiveGoalsSummary,
  renderSystemPrompt,
  type MemoryBundle,
  type UpcomingCalendarEvent,
  type VectorHit,
} from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile } from '../src/lib/database.types'

interface ChatRequestBody {
  messages?: GroqMessage[]
  userId?: string
  // Pre-fetched Tavily results the user explicitly confirmed via the
  // search confirm bubble (PRD 5.3) — never populated automatically.
  searchContext?: string
}

const VECTOR_HITS_PER_SOURCE = 5
const VECTOR_HITS_TOTAL = 5

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

    stage = 'load_user_context'
    const [{ data: profile, error: profileError }, { data: patterns }, { data: summaries }, { data: goalRows }] =
      await Promise.all([
        supabase.from('profiles').select('*').eq('id', user.id).single(),
        supabase.from('pattern_extractions').select('*').eq('user_id', user.id).maybeSingle(),
        supabase
          .from('memory_summaries')
          .select('*')
          .eq('user_id', user.id)
          .order('period_end', { ascending: false })
          .limit(20),
        supabase.from('goals').select('*').eq('user_id', user.id).in('type', ['big_goal', 'increment']),
      ])

    if (profileError || !profile) {
      console.error('chat failed at stage "load_user_context": no profile row for this user', profileError)
      res.status(500).json({ error: 'Could not load user profile' })
      return
    }

    // Embed the new message once, up front: this exact embedding is both
    // (a) the query vector for this request's semantic search, and (b) what
    // gets stored on the chat_history row — no reason to compute it twice.
    stage = 'embed_message'
    const { data: embedData } = await supabase.functions.invoke<{ embedding: number[] }>('embed-text', {
      body: { text: latestUserMessage.content },
    })
    const embedding = embedData?.embedding ?? null

    stage = 'vector_search'
    let vectorHits: VectorHit[] = []
    if (embedding) {
      const [journalHits, chatHits] = await Promise.all([
        supabase.rpc('match_journal_entries', {
          query_embedding: embedding,
          match_user_id: user.id,
          match_count: VECTOR_HITS_PER_SOURCE,
        }),
        supabase.rpc('match_chat_history', {
          query_embedding: embedding,
          match_user_id: user.id,
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
      vectorHits = combined.sort((a, b) => b.similarity - a.similarity).slice(0, VECTOR_HITS_TOTAL)
    }

    stage = 'insert_user_message'
    await supabase.from('chat_history').insert({
      user_id: user.id,
      role: 'user',
      content: latestUserMessage.content,
      embedding,
    })

    // Fully optional and never allowed to break chat: an expired/revoked
    // Google token, a Calendar API hiccup, or simply never having
    // connected all resolve to "omit the <calendar> block" (7.2 / 6.2).
    stage = 'fetch_calendar'
    let upcomingEvents: UpcomingCalendarEvent[] | undefined
    try {
      const connection = await getValidAccessToken(supabase, user.id)
      if (connection) {
        upcomingEvents = await listUpcomingEvents(connection.accessToken, connection.calendarId)
      }
    } catch (err) {
      console.error('chat: calendar fetch failed, continuing without it', err)
    }

    stage = 'build_system_prompt'
    const bundle: MemoryBundle = {
      profile: profile as Profile,
      patterns: (patterns as PatternExtraction) ?? null,
      summaries: summaries ?? [],
      vectorHits,
      activeGoals: buildActiveGoalsSummary(goalRows ?? []),
      upcomingEvents,
    }

    const { prompt: systemPrompt } = renderSystemPrompt(bundle)

    const groqMessages: GroqMessage[] = [{ role: 'system', content: systemPrompt }]
    if (body.searchContext) {
      groqMessages.push({
        role: 'system',
        content: `<search_results>\n${body.searchContext}\n</search_results>`,
      })
    }

    // Conversation Engine (PRD 7.0): a fast gpt-oss-20b pre-call decides
    // what kind of conversational move this response should make, then
    // that directive is injected as its own system message right before
    // the actual user/assistant turns.
    stage = 'analyze_conversation'
    const analysis = await analyzeConversation(apiKey, body.messages.slice(-8))
    groqMessages.push({ role: 'system', content: buildConversationDirective(analysis) })
    if (analysis.multi_message) {
      groqMessages.push({
        role: 'system',
        content: `Respond with ONLY a JSON object: {"messages": [{"text": string, "delay": number}]} — exactly ${analysis.message_count} messages, delays in milliseconds increasing from 0 (e.g. 0, 800, 1600), each a short separate text as if sent one after another like real texts.`,
      })
    }
    groqMessages.push(...body.messages)

    if (analysis.multi_message) {
      stage = 'call_groq_multi_message'
      let raw: string
      try {
        raw = await callGroq(apiKey, {
          model: GROQ_PRIMARY_MODEL,
          jsonMode: true,
          maxTokens: 500,
          temperature: 0.85,
          messages: groqMessages,
        })
      } catch (err) {
        console.error('chat failed at stage "call_groq_multi_message"', err)
        res.status(502).json({ error: 'Groq API request failed', detail: String(err) })
        return
      }

      let parsedMessages: { text: string; delay: number }[] = []
      try {
        const parsed = JSON.parse(raw) as { messages?: unknown }
        if (Array.isArray(parsed.messages)) {
          parsedMessages = parsed.messages
            .filter(
              (m): m is { text: string; delay?: unknown } =>
                !!m && typeof m === 'object' && typeof (m as { text?: unknown }).text === 'string' &&
                (m as { text: string }).text.trim().length > 0,
            )
            .slice(0, 3)
            .map((m, i) => ({
              text: m.text.trim(),
              delay: typeof m.delay === 'number' && Number.isFinite(m.delay) ? m.delay : i * 800,
            }))
        }
      } catch {
        // Malformed multi-message JSON — fall back to the raw text as one
        // message rather than failing the whole request over response shape.
      }
      if (parsedMessages.length === 0) {
        parsedMessages = [{ text: raw.trim(), delay: 0 }]
      }

      stage = 'background_bookkeeping'
      const assembled = parsedMessages.map((m) => m.text).join('\n\n')
      await Promise.allSettled([
        supabase.from('chat_history').insert({ user_id: user.id, role: 'assistant', content: assembled }),
        supabase.functions.invoke('extract-patterns', {
          body: { userId: user.id, content: latestUserMessage.content },
        }),
      ])

      res.status(200).json({ messages: parsedMessages })
      return
    }

    stage = 'call_groq_stream'
    let upstream: Response
    try {
      upstream = await streamGroq(apiKey, { model: GROQ_PRIMARY_MODEL, messages: groqMessages })
    } catch (err) {
      console.error('chat failed at stage "call_groq_stream"', err)
      res.status(502).json({ error: 'Groq API request failed', detail: String(err) })
      return
    }

    stage = 'stream_response'
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')

    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let assembled = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const delta = parseGroqStreamLine(line)
          if (delta) {
            assembled += delta
            res.write(delta)
          }
        }
      }
    } finally {
      res.end()
    }

    // The client already has the full reply by now — everything below is
    // background bookkeeping the user never waits on.
    stage = 'background_bookkeeping'
    await Promise.allSettled([
      supabase.from('chat_history').insert({ user_id: user.id, role: 'assistant', content: assembled }),
      supabase.functions.invoke('extract-patterns', {
        body: { userId: user.id, content: latestUserMessage.content },
      }),
    ])
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
