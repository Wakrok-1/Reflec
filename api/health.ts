import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq } from './_lib/groq'
import { callGemini, type GeminiMessage } from './_lib/gemini'
import {
  analyzeConversation,
  buildConversationDirective,
  buildMultiMessageInstruction,
} from './_lib/conversationAnalyzer'
import { buildActiveGoalsSummary, estimateTokens, renderSystemPrompt, type MemoryBundle } from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile, SelfConcept } from '../src/lib/database.types'

type HealthAction = 'conversation-debug'

interface HealthRequestBody {
  action?: HealthAction
  testMessage?: string
}

// Sprint 0 connectivity check: confirms GROQ_API_KEY is wired up and the
// model actually responds. Not the real chat endpoint (that's api/chat.ts
// with full memory injection) — this just proves the pipe works end to
// end: browser -> this function -> Groq.
async function handleConnectivityCheck(apiKey: string, res: VercelResponse) {
  const message = await callGroq(apiKey, {
    maxTokens: 64,
    messages: [
      {
        role: 'user',
        content:
          'Reply with exactly one short sentence confirming you are online and ready, as Your Reflection.',
      },
    ],
  })
  res.status(200).json({ ok: true, message })
}

// Development-only introspection into the Conversation Engine (PRD 7.0).
// Runs the exact same analyzer -> directive -> main-model pipeline
// api/chat.ts uses (analyzer on Groq, main response on Gemini — see
// api/_lib/gemini.ts), for a single test message, and returns every
// intermediate value instead of just the final reply — so multi-message
// behavior can be verified directly instead of by reading Vercel logs.
// Vector search and calendar are deliberately left out of the context
// built here: this endpoint verifies the Conversation Engine itself, not
// memory-retrieval quality, and skipping them avoids an extra embedding
// round trip on a debug-only call.
async function handleConversationDebug(
  res: VercelResponse,
  groqApiKey: string,
  accessToken: string,
  userId: string,
  testMessage: string,
) {
  const supabase = createUserScopedClient(accessToken)
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

  if (profileError || !profile) {
    res.status(500).json({ error: 'Could not load user profile' })
    return
  }

  const bundle: MemoryBundle = {
    profile: profile as Profile,
    patterns: (patterns as PatternExtraction) ?? null,
    summaries: summaries ?? [],
    vectorHits: [],
    activeGoals: buildActiveGoalsSummary(goalRows ?? []),
    upcomingEvents: undefined,
    selfConcept: (selfConcept as SelfConcept) ?? null,
  }
  const { prompt: systemPrompt } = renderSystemPrompt(bundle)

  const testTurn: GeminiMessage[] = [{ role: 'user', content: testMessage }]
  const analysis = await analyzeConversation(groqApiKey, testTurn)
  const directive = buildConversationDirective(analysis)

  const systemPromptParts = [systemPrompt, directive]
  if (analysis.multi_message) {
    systemPromptParts.push(buildMultiMessageInstruction(analysis))
  }
  const geminiSystemPrompt = systemPromptParts.join('\n\n')

  const contextTokenCount = estimateTokens([geminiSystemPrompt, ...testTurn.map((m) => m.content)].join('\n'))

  let rawModelResponse: string
  try {
    rawModelResponse = await callGemini({
      systemPrompt: geminiSystemPrompt,
      messages: testTurn,
      maxTokens: analysis.multi_message ? 700 : 1500,
      temperature: analysis.multi_message ? 0.85 : 0.8,
      jsonMode: analysis.multi_message,
    })
  } catch (err) {
    res.status(502).json({ error: 'Gemini API request failed', detail: String(err) })
    return
  }

  res.status(200).json({ analysis, directive, contextTokenCount, rawModelResponse })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const user = await verifyUser(req.headers.authorization)
    if (!user || !accessToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
      return
    }

    const body = (req.body ?? {}) as HealthRequestBody
    if (body.action === 'conversation-debug') {
      const testMessage = body.testMessage?.trim()
      if (!testMessage) {
        res.status(400).json({ error: '"testMessage" is required' })
        return
      }
      await handleConversationDebug(res, apiKey, accessToken, user.id, testMessage)
      return
    }

    await handleConnectivityCheck(apiKey, res)
  } catch (err) {
    console.error('health failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
