// Supabase Edge Function — after a chat message (or journal/snap entry),
// runs three Groq passes: (1) update the user's aggregate pattern_extractions
// JSON, (2) identify typed memory entities and store them in `memories`,
// (3) update the Self-Concept Layer (`self_concept` — PRD v1.6 Part 2):
// declared/observed identity, tensions, evolution over time, confidence
// scores, and interaction_memory (what has/hasn't worked talking to this
// person).
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
const CONFIDENCE_DIMENSIONS = ['surface', 'values', 'behaviour', 'emotional_patterns', 'self_concept', 'deep_identity']
const CONFIDENCE_INCREMENT = 0.01

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

interface DeclaredSelfEntry {
  value: string
  source: string
}

interface ObservedBehavior {
  text: string
  confidence: number
}

interface SelfConceptExtraction {
  declared_self?: Record<string, DeclaredSelfEntry>
  observed_behaviors?: ObservedBehavior[]
  identity_tensions?: string[]
  evidence_dimensions?: string[]
  identity_evolution_note?: string | null
}

interface InteractionMemoryEntry {
  text: string
  created_at: string
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

const SELF_CONCEPT_SCHEMA_PROMPT = `You are extracting self-concept signals from one message from a user of
"Your Reflection", to update a running long-term model of who they are
and how they see themselves. Only extract what this message actually
supports — leave fields empty/null when nothing qualifies. Do not invent
detail.

Respond with ONLY a JSON object matching this exact schema, no other text:

{
  "declared_self": { "<dimension>": { "value": string, "source": "user_declared" } },
  "observed_behaviors": [ { "text": string, "confidence": number } ],
  "identity_tensions": string[],
  "evidence_dimensions": ("surface" | "values" | "behaviour" | "emotional_patterns" | "self_concept" | "deep_identity")[],
  "identity_evolution_note": string | null
}

"declared_self" captures explicit self-declarations only — phrases like
"I am...", "I've always been...", "I think I'm...". Use a short
dimension key (e.g. "class", "abilities", "identity") as the object key.

"observed_behaviors" are inferences YOU make from how they write or act
in this message, not things they said about themselves directly —
confidence is 0-1, how sure you are this is a real, recurring pattern
rather than a one-off.

"identity_tensions" are short phrases naming a contradiction between two
parts of how they see/present themselves (e.g. "independence ↔
loneliness"). Only include a new one if this message clearly evidences it.

"evidence_dimensions" lists which confidence dimensions this message gave
any real evidence for (can be empty — most single messages won't touch all six).

"identity_evolution_note" is a short (<15 word) description of their
current developmental focus if this message clearly suggests one (e.g.
"building — questioning whether they want it"), otherwise null. Most
messages should return null here — only set it when the message actually
marks a shift or a clear current chapter.`

const CORRECTION_PATTERNS: RegExp[] = [
  /that'?s not (what i meant|right|true|it)/i,
  /no,? that'?s not/i,
  /you (got that|misunderstood)/i,
  /not what i (said|meant)/i,
]

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

// --- Self-Concept Layer merge helpers (PRD v1.6 Part 2) ---

function mergeDeclaredSelf(
  existing: unknown,
  incoming: Record<string, DeclaredSelfEntry> | undefined,
): Record<string, DeclaredSelfEntry> {
  const merged = { ...((existing as Record<string, DeclaredSelfEntry>) ?? {}) }
  if (!incoming) return merged
  for (const [key, entry] of Object.entries(incoming)) {
    if (entry?.value) merged[key] = { value: entry.value, source: entry.source || 'user_declared' }
  }
  return merged
}

// A repeated observation strengthens confidence in that pattern rather
// than just appending a near-duplicate — matched case-insensitively on
// the exact phrasing, which is a deliberately loose bar (good enough to
// avoid unbounded growth, not meant to be semantic dedup).
function mergeObservedPatterns(
  existing: unknown,
  incoming: ObservedBehavior[] | undefined,
): { patterns: ObservedBehavior[] } {
  const existingPatterns = ((existing as { patterns?: ObservedBehavior[] })?.patterns) ?? []
  const merged = [...existingPatterns]
  for (const item of incoming ?? []) {
    if (!item?.text) continue
    const idx = merged.findIndex((p) => p.text.toLowerCase() === item.text.toLowerCase())
    if (idx >= 0) {
      merged[idx] = { text: merged[idx].text, confidence: Math.min(1, merged[idx].confidence + 0.05) }
    } else {
      merged.push({ text: item.text, confidence: Math.min(1, Math.max(0, item.confidence ?? 0.5)) })
    }
  }
  return { patterns: merged.slice(-MAX_LIST_LENGTH) }
}

// +0.01 per dimension per message that evidences it, capped at 1 — a
// slow, monotonic climb rather than the old single on/off
// personality_emergence_unlocked gate.
function bumpConfidenceScores(existing: unknown, dimensions: string[] | undefined): Record<string, number> {
  const base: Record<string, number> = Object.fromEntries(CONFIDENCE_DIMENSIONS.map((d) => [d, 0]))
  const current = { ...base, ...((existing as Record<string, number>) ?? {}) }
  for (const dim of dimensions ?? []) {
    if (CONFIDENCE_DIMENSIONS.includes(dim)) {
      current[dim] = Math.min(1, (current[dim] ?? 0) + CONFIDENCE_INCREMENT)
    }
  }
  return current
}

// One entry per calendar month — a new message in the same month updates
// that month's description instead of appending a duplicate, so
// identity_evolution reads as a timeline, not a message log.
function upsertEvolutionPeriod(
  existing: unknown,
  note: string | null | undefined,
): { period: string; description: string }[] {
  const list = Array.isArray(existing) ? (existing as { period: string; description: string }[]) : []
  if (!note || !note.trim()) return list
  const periodLabel = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  const idx = list.findIndex((p) => p.period === periodLabel)
  const next = [...list]
  if (idx >= 0) {
    next[idx] = { period: periodLabel, description: note.trim() }
  } else {
    next.push({ period: periodLabel, description: note.trim() })
  }
  return next.slice(-MAX_LIST_LENGTH)
}

function mergeInteractionMemoryList(existing: unknown, incoming: InteractionMemoryEntry[]): InteractionMemoryEntry[] {
  const existingList = Array.isArray(existing) ? (existing as InteractionMemoryEntry[]) : []
  if (incoming.length === 0) return existingList
  return [...existingList, ...incoming].slice(-MAX_LIST_LENGTH)
}

function mergeInteractionMemory(
  existing: unknown,
  incoming: {
    interpretations_rejected: InteractionMemoryEntry[]
    topics_that_expand: InteractionMemoryEntry[]
    response_styles_preferred: InteractionMemoryEntry[]
  },
): Record<string, InteractionMemoryEntry[]> {
  const existingRecord = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  return {
    callbacks_worked: Array.isArray(existingRecord.callbacks_worked) ? (existingRecord.callbacks_worked as InteractionMemoryEntry[]) : [],
    interpretations_rejected: mergeInteractionMemoryList(existingRecord.interpretations_rejected, incoming.interpretations_rejected),
    topics_that_expand: mergeInteractionMemoryList(existingRecord.topics_that_expand, incoming.topics_that_expand),
    topics_that_close: Array.isArray(existingRecord.topics_that_close) ? (existingRecord.topics_that_close as InteractionMemoryEntry[]) : [],
    humour_landed: Array.isArray(existingRecord.humour_landed) ? (existingRecord.humour_landed as InteractionMemoryEntry[]) : [],
    response_styles_preferred: mergeInteractionMemoryList(existingRecord.response_styles_preferred, incoming.response_styles_preferred),
  }
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

    // --- Pass 3: Self-Concept Layer (PRD v1.6 Part 2) ---
    // Isolated in its own try/catch — passes 1 and 2 above are the
    // established, working pipeline; a failure extracting or updating
    // self-concept shouldn't undo them or fail the whole invocation
    // (this runs fire-and-forget from api/chat.ts anyway).
    try {
      const { data: existingSelfConcept } = await supabase
        .from('self_concept')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      const selfConceptRaw = (await callGroq(groqApiKey, SELF_CONCEPT_SCHEMA_PROMPT, content)) as SelfConceptExtraction

      // Recent chat history (most recent first) — used for two heuristic
      // interaction_memory signals below: whether this message is
      // correcting the AI's last interpretation, and whether it's a much
      // longer reply than usual (a sign the previous topic "expanded"
      // them rather than closing them down).
      const { data: recentHistory } = await supabase
        .from('chat_history')
        .select('role, content')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(6)

      const lastAssistantMessage = (recentHistory ?? []).find((m: { role: string }) => m.role === 'assistant') as
        | { content: string }
        | undefined
      const priorUserMessages = (recentHistory ?? []).filter((m: { role: string }) => m.role === 'user') as {
        content: string
      }[]
      const avgUserLength = priorUserMessages.length
        ? priorUserMessages.reduce((sum: number, m: { content: string }) => sum + m.content.length, 0) /
          priorUserMessages.length
        : content.length

      const nowIso = new Date().toISOString()
      const interpretationsRejected: InteractionMemoryEntry[] =
        lastAssistantMessage && CORRECTION_PATTERNS.some((p) => p.test(content))
          ? [{ text: lastAssistantMessage.content.slice(0, 300), created_at: nowIso }]
          : []
      const topicsThatExpand: InteractionMemoryEntry[] =
        lastAssistantMessage && content.length > avgUserLength * 1.5 && content.length > 80
          ? [{ text: lastAssistantMessage.content.trim().split(/\s+/).slice(0, 8).join(' '), created_at: nowIso }]
          : []

      // Any "felt right" tap recorded since self_concept was last updated,
      // with a chat_message_id (Chat.tsx wires this through — see
      // markFeltRight), turns into a response-style preference: what
      // shape of response landed for this specific person.
      const sinceTimestamp = existingSelfConcept?.updated_at ?? '1970-01-01T00:00:00.000Z'
      const { data: newFeltRightSignals } = await supabase
        .from('response_signals')
        .select('chat_message_id')
        .eq('user_id', userId)
        .eq('felt_right', true)
        .not('chat_message_id', 'is', null)
        .gt('created_at', sinceTimestamp)
        .order('created_at', { ascending: false })
        .limit(5)

      const responseStylesPreferred: InteractionMemoryEntry[] = []
      for (const signal of (newFeltRightSignals ?? []) as { chat_message_id: string }[]) {
        const { data: respondedMessage } = await supabase
          .from('chat_history')
          .select('content')
          .eq('id', signal.chat_message_id)
          .maybeSingle()
        if (!respondedMessage) continue
        const len = (respondedMessage as { content: string }).content.length
        const lengthBucket = len < 80 ? 'short' : len < 220 ? 'medium' : 'long'
        const text = (respondedMessage as { content: string }).content
        const usedHumor = /(lol|lmao|😭|💀|haha)/i.test(text)
        const usedMemory = /(you (mentioned|said)|remember when|like (you|last time))/i.test(text)
        responseStylesPreferred.push({
          text: `${lengthBucket} response${usedHumor ? ', humor' : ''}${usedMemory ? ', referenced memory' : ''}`,
          created_at: nowIso,
        })
      }

      await supabase.from('self_concept').upsert({
        user_id: userId,
        declared_self: mergeDeclaredSelf(existingSelfConcept?.declared_self, selfConceptRaw.declared_self),
        observed_self: mergeObservedPatterns(existingSelfConcept?.observed_self, selfConceptRaw.observed_behaviors),
        identity_tensions: mergeUnion(existingSelfConcept?.identity_tensions, selfConceptRaw.identity_tensions),
        identity_evolution: upsertEvolutionPeriod(
          existingSelfConcept?.identity_evolution,
          selfConceptRaw.identity_evolution_note,
        ),
        confidence_scores: bumpConfidenceScores(existingSelfConcept?.confidence_scores, selfConceptRaw.evidence_dimensions),
        interaction_memory: mergeInteractionMemory(existingSelfConcept?.interaction_memory, {
          interpretations_rejected: interpretationsRejected,
          topics_that_expand: topicsThatExpand,
          response_styles_preferred: responseStylesPreferred,
        }),
        updated_at: nowIso,
      })
    } catch (selfConceptErr) {
      console.error('extract-patterns: self-concept pass failed, patterns/memories already saved', selfConceptErr)
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
