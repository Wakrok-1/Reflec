import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GROQ_PRIMARY_MODEL } from './_lib/groq'
import { renderSystemPrompt, type MemoryBundle } from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile } from '../src/lib/database.types'

interface ReflectRequestBody {
  entryId?: string
  content?: string
}

const SKIP_TOKEN = 'SKIP'

// Full Journal mode's optional AI reflection (PRD 5.4): specific to what
// was written, never generic, and the user can skip it. Stores the
// result (or null, if skipped) directly on the journal_entries row.
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

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
    return
  }

  const body = req.body as ReflectRequestBody
  if (typeof body.entryId !== 'string' || typeof body.content !== 'string' || !body.content.trim()) {
    res.status(400).json({ error: '"entryId" and "content" are required' })
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

  const bundle: MemoryBundle = {
    profile: profile as Profile,
    patterns: (patterns as PatternExtraction) ?? null,
    summaries: summaries ?? [],
    vectorHits: [],
  }
  const { prompt: systemPrompt } = renderSystemPrompt(bundle)

  try {
    const reply = await callGroq(apiKey, {
      model: GROQ_PRIMARY_MODEL,
      maxTokens: 250,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Here's what I just wrote in my journal:\n\n"""\n${body.content}\n"""\n\nOffer a brief, specific reflection if something genuinely stands out to you — 2-4 sentences, following your usual rules. If there's truly nothing worth adding beyond what they already wrote, respond with exactly: ${SKIP_TOKEN}`,
        },
      ],
    })

    const trimmed = reply.trim()
    const reflection = trimmed === SKIP_TOKEN ? null : trimmed

    await supabase.from('journal_entries').update({ ai_reflection: reflection }).eq('id', body.entryId).eq(
      'user_id',
      user.id,
    )

    res.status(200).json({ reflection })
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error calling Groq API', detail: String(err) })
  }
}
