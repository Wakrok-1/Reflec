// Supabase Edge Function — after a chat message (or journal/snap entry),
// runs two Groq passes: (1) update the user's aggregate pattern_extractions
// JSON, (2) identify typed memory entities and store them in `memories`,
// each embedded via gte-small (PRD "Sprint 2 — Chat Core", items 5 and 8).
//
// Deploy: npx supabase functions deploy extract-patterns
// Set the Groq secret once: npx supabase secrets set GROQ_API_KEY=...
// Requires a valid Supabase user JWT and writes through that user's own
// RLS policies — no service-role key.
//
// Request: POST { userId: string, content: string }

// @ts-ignore Deno global + remote std import, not resolved by the app's Node/tsc setup.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
// @ts-ignore Remote ESM import, resolved by the Deno edge runtime, not the app's Node/tsc setup.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'openai/gpt-oss-120b'
const MEMORY_TYPES = ['EVENT', 'BELIEF', 'GOAL', 'PREFERENCE', 'EMOTION', 'HABIT', 'ACHIEVEMENT', 'PROBLEM']
const MAX_LIST_LENGTH = 15

interface ExtractRequest {
  userId?: unknown
  content?: unknown
}

interface TasteEntry {
  item: string
  context: string | null
}

interface PatternExtractionResult {
  emotional_triggers: string[]
  coping_patterns: string[]
  energy_patterns: string[]
  communication_style: string | null
  recurring_themes: string[]
  taste_context: Record<string, TasteEntry[]>
  writing_signature: Record<string, unknown>
  response_preference: Record<string, unknown>
}

interface MemoryEntity {
  type: string
  content: string
  confidence: number
}

const PATTERN_SCHEMA_PROMPT = `You are analysing one message from a user of "Your Reflection" to update
their long-term pattern model. Only include something if this message
actually evidences it — leave arrays empty and fields null otherwise. Do
not invent detail.

Respond with ONLY a JSON object matching this exact schema, no other text:

{
  "emotional_triggers": string[],
  "coping_patterns": string[],
  "energy_patterns": string[],
  "communication_style": string | null,
  "recurring_themes": string[],
  "taste_context": { "<category>": [ { "item": string, "context": string | null } ] },
  "writing_signature": { },
  "response_preference": { }
}

"taste_context" categories are: music, books, sport, food, aesthetics, hobbies, symbols.
"writing_signature" may include free-form observations about this message's tone/rhythm if notable, otherwise {}.
"response_preference" is usually {} here — it's populated separately from feedback signals.`

const MEMORY_SCHEMA_PROMPT = `You are extracting typed long-term memories from one message from a user
of "Your Reflection". A memory is a durable fact worth remembering, not
every sentence. Only extract what is clearly stated or clearly implied.

Respond with ONLY a JSON object matching this exact schema, no other text:

{
  "memories": [
    { "type": "EVENT" | "BELIEF" | "GOAL" | "PREFERENCE" | "EMOTION" | "HABIT" | "ACHIEVEMENT" | "PROBLEM",
      "content": string,
      "confidence": number }
  ]
}

"confidence" is 0-1, how sure you are this is a durable, real pattern (not
a one-off remark). Return an empty array if nothing qualifies.`

async function callGroq(apiKey: string, systemPrompt: string, userContent: string): Promise<unknown> {
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  })
  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`)
  }
  const data = await response.json()
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('Groq response had no content')
  return JSON.parse(text)
}

function mergeUnion(existing: unknown, incoming: unknown): string[] {
  const existingArr = Array.isArray(existing) ? existing.map(String) : []
  const incomingArr = Array.isArray(incoming) ? incoming.map(String) : []
  const merged = [...existingArr]
  for (const item of incomingArr) {
    if (!merged.includes(item)) merged.push(item)
  }
  return merged.slice(-MAX_LIST_LENGTH)
}

function mergeTasteContext(
  existing: unknown,
  incoming: Record<string, TasteEntry[]> | undefined,
): Record<string, TasteEntry[]> {
  const merged: Record<string, TasteEntry[]> = { ...((existing as Record<string, TasteEntry[]>) ?? {}) }
  if (!incoming) return merged
  for (const [category, entries] of Object.entries(incoming)) {
    const current = merged[category] ?? []
    for (const entry of entries) {
      const idx = current.findIndex((e) => e.item.toLowerCase() === entry.item.toLowerCase())
      if (idx >= 0) {
        current[idx] = { item: current[idx].item, context: entry.context ?? current[idx].context }
      } else {
        current.push(entry)
      }
    }
    merged[category] = current.slice(-MAX_LIST_LENGTH)
  }
  return merged
}

function mergeRecord(existing: unknown, incoming: unknown): Record<string, unknown> {
  const existingRecord = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  const incomingRecord = (incoming && typeof incoming === 'object' ? incoming : {}) as Record<string, unknown>
  return { ...existingRecord, ...incomingRecord }
}

// @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  let body: ExtractRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }

  const { userId, content } = body
  if (typeof userId !== 'string' || typeof content !== 'string' || !content.trim()) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401 })
  }

  // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
  const groqApiKey = Deno.env.get('GROQ_API_KEY')
  if (!groqApiKey) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY is not configured' }), { status: 500 })
  }

  const supabase = createClient(
    // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
    Deno.env.get('SUPABASE_URL'),
    // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
    Deno.env.get('SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: authHeader } } },
  )

  try {
    // --- Pass 1: pattern extraction ---
    const patternRaw = (await callGroq(groqApiKey, PATTERN_SCHEMA_PROMPT, content)) as Partial<
      PatternExtractionResult
    >

    const { data: existingPatterns } = await supabase
      .from('pattern_extractions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    const { count: feltRightCount } = await supabase
      .from('response_signals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('felt_right', true)

    await supabase.from('pattern_extractions').upsert({
      user_id: userId,
      emotional_triggers: mergeUnion(existingPatterns?.emotional_triggers, patternRaw.emotional_triggers),
      coping_patterns: mergeUnion(existingPatterns?.coping_patterns, patternRaw.coping_patterns),
      energy_patterns: mergeUnion(existingPatterns?.energy_patterns, patternRaw.energy_patterns),
      communication_style: patternRaw.communication_style || existingPatterns?.communication_style || null,
      recurring_themes: mergeUnion(existingPatterns?.recurring_themes, patternRaw.recurring_themes),
      taste_context: mergeTasteContext(existingPatterns?.taste_context, patternRaw.taste_context),
      writing_signature: mergeRecord(existingPatterns?.writing_signature, patternRaw.writing_signature),
      response_preference: mergeRecord(existingPatterns?.response_preference, {
        marked_as_felt_right: feltRightCount ?? 0,
      }),
    })

    // --- Pass 2: typed memory entity extraction ---
    const memoryRaw = (await callGroq(groqApiKey, MEMORY_SCHEMA_PROMPT, content)) as {
      memories?: MemoryEntity[]
    }

    for (const entity of memoryRaw.memories ?? []) {
      if (!MEMORY_TYPES.includes(entity.type) || !entity.content?.trim()) continue

      const { data: existingMemory } = await supabase
        .from('memories')
        .select('id, confidence')
        .eq('user_id', userId)
        .eq('type', entity.type)
        .eq('content', entity.content)
        .maybeSingle()

      if (existingMemory) {
        await supabase
          .from('memories')
          .update({
            confidence: Math.min(1, (existingMemory.confidence ?? 0.5) + 0.1),
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existingMemory.id)
        continue
      }

      // @ts-ignore Supabase is a global provided by the Edge Function runtime.
      const session = new Supabase.ai.Session('gte-small')
      const embedding = (await session.run(entity.content.slice(0, 8000), {
        mean_pool: true,
        normalize: true,
      })) as number[]

      await supabase.from('memories').insert({
        user_id: userId,
        type: entity.type,
        content: entity.content,
        confidence: Math.min(1, Math.max(0, entity.confidence ?? 0.5)),
        embedding,
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Pattern/memory extraction failed', detail: String(err) }), {
      status: 500,
    })
  }
})
