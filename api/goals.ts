import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq } from './_lib/groq'

interface GoalSuggestBody {
  kind?: 'goal' | 'bucket'
}

interface GoalSuggestionResult {
  title: string
  description: string | null
  increments: string[]
}

interface BucketSuggestionResult {
  items: { item: string; context: string | null }[]
}

function sanitizeGoal(raw: unknown): GoalSuggestionResult | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (!title) return null
  const description = typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : null
  const increments = Array.isArray(obj.increments)
    ? obj.increments.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim())
    : []
  return { title, description, increments }
}

function sanitizeBucket(raw: unknown): BucketSuggestionResult {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const itemsRaw = Array.isArray(obj.items) ? obj.items : []
  const items = itemsRaw
    .map((entry): { item: string; context: string | null } | null => {
      if (!entry || typeof entry !== 'object') return null
      const e = entry as Record<string, unknown>
      const item = typeof e.item === 'string' ? e.item.trim() : ''
      if (!item) return null
      const context = typeof e.context === 'string' && e.context.trim() ? e.context.trim() : null
      return { item, context }
    })
    .filter((v): v is { item: string; context: string | null } => v !== null)
    .slice(0, 3)
  return { items }
}

// Explicit, user-triggered AI suggestion for the Goals page (PRD 5.5): the
// user taps "Ask Your Reflection" in either the Big Life Goals or Bucket
// List section, this reads their profile/taste/patterns plus what they
// already have, and proposes one new goal (with increments) or a couple of
// bucket-list ideas — surfaced as suggestion bubbles the user approves or
// dismisses (GUARDRAIL 3: never write without that approval).
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

    const body = req.body as GoalSuggestBody
    const kind = body.kind === 'bucket' ? 'bucket' : 'goal'

    const supabase = createUserScopedClient(accessToken)
    const [{ data: profile }, { data: taste }, { data: patterns }, { data: existingGoals }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('taste_profile').select('*').eq('user_id', user.id),
      supabase.from('pattern_extractions').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('goals').select('type, title').eq('user_id', user.id),
    ])

    const tasteLines = (taste ?? []).map((t) => `${t.category}: ${t.item}${t.context ? ` (${t.context})` : ''}`)
    const existingBigGoals = (existingGoals ?? []).filter((g) => g.type === 'big_goal').map((g) => g.title)
    const existingBucketItems = (existingGoals ?? []).filter((g) => g.type === 'bucket_list').map((g) => g.title)

    const contextBlock = `What we know about this person:
Name: ${profile?.name ?? 'unknown'}
Philosophy: ${profile?.philosophy ?? 'not yet shared'}
Core values: ${((profile?.core_values as string[]) ?? []).join(', ') || 'none yet'}
Recurring themes: ${(patterns?.recurring_themes ?? []).join(', ') || 'none yet'}
Taste: ${tasteLines.join('; ') || 'nothing learned yet'}
Existing Big Life Goals (do not repeat these): ${existingBigGoals.join('; ') || 'none yet'}
Existing Bucket List items (do not repeat these): ${existingBucketItems.join('; ') || 'none yet'}`

    if (kind === 'goal') {
      const raw = await callGroq(apiKey, {
        jsonMode: true,
        maxTokens: 500,
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content: `You help suggest one meaningful "Big Life Goal" for a user of the personal growth app Your Reflection, grounded only in what is actually known about them below — never generic filler like "learn a new skill". If nothing grounds a good suggestion yet, still propose something reasonable tied to their stated values or themes.

${contextBlock}

Respond with ONLY a JSON object matching this schema, no other text:
{ "title": string, "description": string | null, "increments": string[] }
"increments" should be 3-6 small, concrete, checkable steps toward the goal.`,
          },
          { role: 'user', content: 'Suggest one goal now.' },
        ],
      })

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        res.status(502).json({ error: 'Groq did not return valid JSON', detail: raw })
        return
      }

      const goal = sanitizeGoal(parsed)
      if (!goal) {
        res.status(502).json({ error: 'Groq returned an empty suggestion' })
        return
      }
      res.status(200).json(goal)
      return
    }

    const raw = await callGroq(apiKey, {
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `You suggest Bucket List experiences (life experiences the user wants to have — not tasks or habits) for a user of the personal growth app Your Reflection, grounded in their taste profile and recurring themes below.

${contextBlock}

Respond with ONLY a JSON object matching this schema, no other text:
{ "items": [{ "item": string, "context": string | null }] }
Suggest 1-3 items. "context" briefly says why it fits them — leave null if there's no clear tie.`,
        },
        { role: 'user', content: 'Suggest bucket list items now.' },
      ],
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      res.status(502).json({ error: 'Groq did not return valid JSON', detail: raw })
      return
    }

    res.status(200).json(sanitizeBucket(parsed))
  } catch (err) {
    console.error('goals (suggest) failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
