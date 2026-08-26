import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { GROQ_PRIMARY_MODEL, parseGroqStreamLine, streamGroq, type GroqMessage } from './_lib/groq'
import { renderSystemPrompt, type MemoryBundle, type VectorHit } from '../src/lib/contextBuilder'
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

  const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const user = await verifyUser(req.headers.authorization)
  if (!user || !accessToken) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = req.body as ChatRequestBody
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: '"messages" must be a non-empty array' })
    return
  }
  if (body.userId && body.userId !== user.id) {
    res.status(403).json({ error: 'userId does not match the authenticated session' })
    return
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
    return
  }

  const latestUserMessage = [...body.messages].reverse().find((m) => m.role === 'user')
  if (!latestUserMessage) {
    res.status(400).json({ error: 'messages must contain at least one user turn' })
    return
  }

  const supabase = createUserScopedClient(accessToken)

  const [{ data: profile, error: profileError }, { data: patterns }, { data: summaries }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('pattern_extractions').select('*').eq('user_id', user.id).maybeSingle(),
    supabase
      .from('memory_summaries')
      .select('*')
      .eq('user_id', user.id)
      .order('period_end', { ascending: false })
      .limit(20),
  ])

  if (profileError || !profile) {
    res.status(500).json({ error: 'Could not load user profile' })
    return
  }

  // Embed the new message once, up front: this exact embedding is both
  // (a) the query vector for this request's semantic search, and (b) what
  // gets stored on the chat_history row — no reason to compute it twice.
  const { data: embedData } = await supabase.functions.invoke<{ embedding: number[] }>('embed-text', {
    body: { text: latestUserMessage.content },
  })
  const embedding = embedData?.embedding ?? null

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

  await supabase.from('chat_history').insert({
    user_id: user.id,
    role: 'user',
    content: latestUserMessage.content,
    embedding,
  })

  const bundle: MemoryBundle = {
    profile: profile as Profile,
    patterns: (patterns as PatternExtraction) ?? null,
    summaries: summaries ?? [],
    vectorHits,
  }

  const { prompt: systemPrompt } = renderSystemPrompt(bundle)

  const groqMessages: GroqMessage[] = [{ role: 'system', content: systemPrompt }]
  if (body.searchContext) {
    groqMessages.push({
      role: 'system',
      content: `<search_results>\n${body.searchContext}\n</search_results>`,
    })
  }
  groqMessages.push(...body.messages)

  let upstream: Response
  try {
    upstream = await streamGroq(apiKey, { model: GROQ_PRIMARY_MODEL, messages: groqMessages })
  } catch (err) {
    res.status(502).json({ error: 'Groq API request failed', detail: String(err) })
    return
  }

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
  await Promise.allSettled([
    supabase.from('chat_history').insert({ user_id: user.id, role: 'assistant', content: assembled }),
    supabase.functions.invoke('extract-patterns', {
      body: { userId: user.id, content: latestUserMessage.content },
    }),
  ])
}
