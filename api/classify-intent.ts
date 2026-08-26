import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { callGroq, GROQ_CLASSIFIER_MODEL } from './_lib/groq'

interface ClassifyRequestBody {
  message?: string
}

type Intent = 'on_topic' | 'off_topic' | 'search_needed' | 'calendar_event'

interface ClassifyResult {
  intent: Intent
  search_query?: string
  off_topic_reason?: string
  event_title?: string
  event_datetime?: string
  event_duration?: number
}

function classifierPrompt(nowIso: string): string {
  return `You are a lightweight pre-check for a personal companion chat app called
Reflec. The companion, Your Reflection, only talks about the user's
personal growth, emotional life, goals, relationships, and self-understanding
— never coding, math, homework, trivia, or news.

The current date and time is ${nowIso} — resolve any relative date/time the
user mentions ("tomorrow", "next Tuesday at 3", "in an hour") against this.

Classify the user's message into exactly one of:
- "on_topic": personal, emotional, reflective, or otherwise within scope.
- "off_topic": asks for code, debugging, math, homework help, essay writing,
  technical explanations, trivia, or general knowledge unrelated to their life.
- "search_needed": mentions a specific named song, artist, album, book,
  author, film, place, public figure, or real event where looking it up
  would add grounding — NOT for pure emotional venting, personal reflection,
  goal updates, or snap entries.
- "calendar_event": the user is asking to schedule, book, or remember a
  specific event with an actual date/time (e.g. "add my dentist appt
  tomorrow at 2pm", "remind me I have standup at 10 on Monday") — NOT for
  vague future intentions with no concrete time ("I should call my mom
  sometime").

Respond with ONLY a JSON object matching this schema, no other text:
{
  "intent": "on_topic" | "off_topic" | "search_needed" | "calendar_event",
  "search_query": string | null,
  "off_topic_reason": string | null,
  "event_title": string | null,
  "event_datetime": string | null,
  "event_duration": number | null
}

"search_query" is only set when intent is "search_needed" — a short, precise
query capturing exactly what to look up (e.g. "Cigarettes After Sex — themes
and emotional meaning"). "off_topic_reason" is only set when intent is
"off_topic" — a short phrase naming what kind of off-topic request it was
(e.g. "debugging code"). "event_title", "event_datetime" (a full ISO 8601
timestamp, resolved against the current date/time above), and optionally
"event_duration" (minutes) are only set when intent is "calendar_event" —
leave the whole message as "on_topic" instead if you can't confidently
resolve an actual date/time.`
}

function sanitize(raw: unknown): ClassifyResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const intent = obj.intent
  if (intent !== 'on_topic' && intent !== 'off_topic' && intent !== 'search_needed' && intent !== 'calendar_event') {
    return { intent: 'on_topic' }
  }
  if (intent === 'search_needed') {
    const result: ClassifyResult = { intent }
    if (typeof obj.search_query === 'string' && obj.search_query.trim()) result.search_query = obj.search_query.trim()
    return result
  }
  if (intent === 'off_topic') {
    const result: ClassifyResult = { intent }
    if (typeof obj.off_topic_reason === 'string' && obj.off_topic_reason.trim()) {
      result.off_topic_reason = obj.off_topic_reason.trim()
    }
    return result
  }
  if (intent === 'calendar_event') {
    const title = typeof obj.event_title === 'string' ? obj.event_title.trim() : ''
    const datetime = typeof obj.event_datetime === 'string' ? obj.event_datetime.trim() : ''
    // Both fields are required for a usable calendar_event — fall back to
    // on_topic rather than surfacing a confirm bubble with nothing to confirm.
    if (!title || !datetime || Number.isNaN(new Date(datetime).getTime())) {
      return { intent: 'on_topic' }
    }
    const result: ClassifyResult = { intent, event_title: title, event_datetime: datetime }
    if (typeof obj.event_duration === 'number' && Number.isFinite(obj.event_duration) && obj.event_duration > 0) {
      result.event_duration = obj.event_duration
    }
    return result
  }
  return { intent: 'on_topic' }
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

  let user
  try {
    user = await verifyUser(req.headers.authorization)
  } catch (err) {
    // A throw here means the auth check itself is broken (e.g. a bad
    // Supabase env var), not that the request is unauthenticated — that
    // must come back as JSON, never fail open, and never let an uncaught
    // throw hit Vercel's plain-text crash page.
    console.error('classify-intent auth check failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
    return
  }
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
        { role: 'system', content: classifierPrompt(new Date().toISOString()) },
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
