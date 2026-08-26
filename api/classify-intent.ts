import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { callGroq, GROQ_CLASSIFIER_MODEL } from './_lib/groq'

interface ClassifyRequestBody {
  message?: string
}

type Intent = 'on_topic' | 'off_topic' | 'search_needed'

interface ClassifyResult {
  intent: Intent
  search_query?: string
  off_topic_reason?: string
}

const CLASSIFIER_PROMPT = `You are a lightweight pre-check for a personal companion chat app called
Reflec. The companion, Your Reflection, only talks about the user's
personal growth, emotional life, goals, relationships, and self-understanding
— never coding, math, homework, trivia, or news.

Classify the user's message into exactly one of:
- "on_topic": personal, emotional, reflective, or otherwise within scope.
- "off_topic": asks for code, debugging, math, homework help, essay writing,
  technical explanations, trivia, or general knowledge unrelated to their life.
- "search_needed": mentions a specific named song, artist, album, book,
  author, film, place, public figure, or real event where looking it up
  would add grounding — NOT for pure emotional venting, personal reflection,
  goal updates, or snap entries.

Respond with ONLY a JSON object matching this schema, no other text:
{
  "intent": "on_topic" | "off_topic" | "search_needed",
  "search_query": string | null,
  "off_topic_reason": string | null
}

"search_query" is only set when intent is "search_needed" — a short, precise
query capturing exactly what to look up (e.g. "Cigarettes After Sex — themes
and emotional meaning"). "off_topic_reason" is only set when intent is
"off_topic" — a short phrase naming what kind of off-topic request it was
(e.g. "debugging code").`

function sanitize(raw: unknown): ClassifyResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const intent = obj.intent
  if (intent !== 'on_topic' && intent !== 'off_topic' && intent !== 'search_needed') {
    return { intent: 'on_topic' }
  }
  const result: ClassifyResult = { intent }
  if (intent === 'search_needed' && typeof obj.search_query === 'string' && obj.search_query.trim()) {
    result.search_query = obj.search_query.trim()
  }
  if (intent === 'off_topic' && typeof obj.off_topic_reason === 'string' && obj.off_topic_reason.trim()) {
    result.off_topic_reason = obj.off_topic_reason.trim()
  }
  return result
}

// Token guardrail (PRD 5.3): a cheap gpt-oss-20b pre-check that runs
// before every main model call. Off-topic messages never reach
// gpt-oss-120b; search-worthy ones get flagged for the confirm bubble
// instead of triggering a search automatically.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const user = await verifyUser(req.headers.authorization)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
    return
  }

  const body = req.body as ClassifyRequestBody
  if (typeof body.message !== 'string' || !body.message.trim()) {
    res.status(400).json({ error: '"message" must be a non-empty string' })
    return
  }

  try {
    const raw = await callGroq(apiKey, {
      model: GROQ_CLASSIFIER_MODEL,
      jsonMode: true,
      maxTokens: 150,
      temperature: 0,
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: body.message },
      ],
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Fail open — if the classifier itself misbehaves, don't block the
      // user from talking to Your Reflection.
      res.status(200).json({ intent: 'on_topic' } satisfies ClassifyResult)
      return
    }

    res.status(200).json(sanitize(parsed))
  } catch (err) {
    console.error('classify-intent failed, failing open to on_topic', err)
    res.status(200).json({ intent: 'on_topic' } satisfies ClassifyResult)
  }
}
