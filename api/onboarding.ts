import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, type GroqMessage } from './_lib/groq'
import { IDENTITY_BLOCK } from './_lib/systemPrompt'
import { renderSystemPrompt, type MemoryBundle } from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile } from '../src/lib/database.types'

type OnboardingAction = 'chat' | 'finalize'

interface OnboardingRequestBody {
  action?: OnboardingAction
  messages?: GroqMessage[]
}

const TASTE_CATEGORIES = ['music', 'books', 'sport', 'food', 'aesthetics', 'hobbies', 'symbols'] as const
type TasteCategory = (typeof TASTE_CATEGORIES)[number]

interface ExtractedTasteItem {
  category: TasteCategory
  item: string
  context: string | null
}

interface ExtractedProfile {
  name: string | null
  age: number | null
  class: string | null
  strengths: string[]
  philosophy: string | null
  core_values: string[]
}

interface OnboardingExtraction {
  profile: ExtractedProfile
  taste: ExtractedTasteItem[]
  summary: string
}

const EXTRACTION_SCHEMA_PROMPT = `You just finished the onboarding interview with a user of "Your Reflection".
Read the full conversation and extract what they revealed about themselves.
Only include something if the user actually said it or clearly implied it —
never invent details. Leave fields null or empty arrays if not covered.

Respond with ONLY a JSON object matching this exact schema, no other text:

{
  "profile": {
    "name": string | null,
    "age": number | null,
    "class": string | null,
    "strengths": string[],
    "philosophy": string | null,
    "core_values": string[]
  },
  "taste": [
    { "category": "music" | "books" | "sport" | "food" | "aesthetics" | "hobbies" | "symbols", "item": string, "context": string | null }
  ],
  "summary": string
}

"class" is a self-defined archetype the user names for themselves (e.g. Survivor, Builder, Dreamer) —
leave it null unless they actually described themselves that way.
"context" on a taste item should capture *why* or *when*, not just repeat the item — e.g.
"listens to it late at night when processing something he can't say out loud" — leave null if no
emotional context was shared.
"summary" is a short third-person paragraph (3-5 sentences) capturing who this person is and what
they're going through right now, written for the AI's own future memory, not for the user to read.`

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

function sanitizeExtraction(raw: unknown): OnboardingExtraction {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const profileRaw = (obj.profile && typeof obj.profile === 'object' ? obj.profile : {}) as Record<
    string,
    unknown
  >

  const profile: ExtractedProfile = {
    name: typeof profileRaw.name === 'string' && profileRaw.name.trim() ? profileRaw.name.trim() : null,
    age: typeof profileRaw.age === 'number' && Number.isFinite(profileRaw.age) ? profileRaw.age : null,
    class: typeof profileRaw.class === 'string' && profileRaw.class.trim() ? profileRaw.class.trim() : null,
    strengths: sanitizeStringArray(profileRaw.strengths),
    philosophy:
      typeof profileRaw.philosophy === 'string' && profileRaw.philosophy.trim()
        ? profileRaw.philosophy.trim()
        : null,
    core_values: sanitizeStringArray(profileRaw.core_values),
  }

  const tasteRaw = Array.isArray(obj.taste) ? obj.taste : []
  const taste: ExtractedTasteItem[] = tasteRaw
    .map((entry): ExtractedTasteItem | null => {
      if (!entry || typeof entry !== 'object') return null
      const e = entry as Record<string, unknown>
      const category = e.category
      const item = e.item
      if (typeof item !== 'string' || !item.trim()) return null
      if (typeof category !== 'string' || !TASTE_CATEGORIES.includes(category as TasteCategory)) return null
      const context = typeof e.context === 'string' && e.context.trim() ? e.context.trim() : null
      return { category: category as TasteCategory, item: item.trim(), context }
    })
    .filter((v): v is ExtractedTasteItem => v !== null)

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''

  return { profile, taste, summary }
}

// One turn of the onboarding AI interview (PRD 5.1). Stateless — the
// client sends the full conversation so far, this returns Your
// Reflection's next message.
//
// Uses the SAME unified system prompt as api/chat.ts (src/lib/systemPrompt.ts,
// rendered via contextBuilder's renderSystemPrompt), not a separate
// onboarding-only prompt — that prompt's own [ONBOARDING MODE] section
// already covers "no profile yet" (a profiles row exists from signup via
// the handle_new_user trigger, just mostly empty pre-onboarding, which
// renders as "unknown"/"not yet shared" placeholders). A second,
// unmaintained copy of the identity/rules text here previously meant
// onboarding never got RULE 8 (no "I hear you" as performance) or the
// [CONVERSATION POLICY] variety added to the main prompt later — it read
// as a flat acknowledge-then-question bot. One prompt, one place to edit.
async function handleChat(req: VercelRequest, res: VercelResponse, body: OnboardingRequestBody) {
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

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: '"messages" must be a non-empty array' })
    return
  }

  const supabase = createUserScopedClient(accessToken)
  const [{ data: profile, error: profileError }, { data: patterns }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('pattern_extractions').select('*').eq('user_id', user.id).maybeSingle(),
  ])
  if (profileError || !profile) {
    res.status(500).json({ error: 'Could not load user profile' })
    return
  }

  const bundle: MemoryBundle = {
    profile: profile as Profile,
    patterns: (patterns as PatternExtraction) ?? null,
    summaries: [],
    vectorHits: [],
    activeGoals: [],
    upcomingEvents: undefined,
  }
  const { prompt: systemPrompt } = renderSystemPrompt(bundle)

  const reply = await callGroq(apiKey, {
    maxTokens: 400,
    temperature: 0.8,
    messages: [{ role: 'system', content: systemPrompt }, ...body.messages],
  })
  res.status(200).json({ reply })
}

// Runs once, when the user ends the onboarding interview. Extracts
// structured profile/taste suggestions from the transcript via a Groq
// JSON-mode call (PRD 7.1: "Pattern extraction — JSON mode enforced").
// Nothing is written to the database here — the client turns this into
// approval bubbles on the Character Profile page (PRD 5.1, 7.3).
async function handleFinalize(req: VercelRequest, res: VercelResponse, body: OnboardingRequestBody) {
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

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: '"messages" must be a non-empty array' })
    return
  }

  const raw = await callGroq(apiKey, {
    jsonMode: true,
    maxTokens: 1200,
    temperature: 0.2,
    messages: [
      { role: 'system', content: `${IDENTITY_BLOCK}\n\n${EXTRACTION_SCHEMA_PROMPT}` },
      ...body.messages,
      { role: 'user', content: 'Extract the JSON now, following the schema exactly.' },
    ],
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    res.status(502).json({ error: 'Groq did not return valid JSON', detail: raw })
    return
  }

  res.status(200).json(sanitizeExtraction(parsed))
}

// Consolidated onboarding endpoint (Vercel Hobby plan's 12-function cap,
// see README): one turn of the interview and the end-of-interview
// extraction pass share this file, routed by a body `action` field.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as OnboardingRequestBody

  try {
    if (body.action === 'finalize') {
      await handleFinalize(req, res, body)
      return
    }
    if (body.action === 'chat') {
      await handleChat(req, res, body)
      return
    }
    res.status(400).json({ error: 'Unknown or missing "action"' })
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's Supabase
    // client to throw, a network hiccup, etc.) must still come back as
    // JSON — an uncaught throw here becomes Vercel's own plain-text crash
    // page, which breaks every client-side `response.json()` call.
    console.error(`onboarding (action=${body.action}) failed`, err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
