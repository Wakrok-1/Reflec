import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, callGroqVision, GROQ_PRIMARY_MODEL } from './_lib/groq'
import { renderSystemPrompt, type MemoryBundle } from '../src/lib/contextBuilder'
import type { PatternExtraction, Profile } from '../src/lib/database.types'

type JournalAction = 'reflect' | 'prompt' | 'turn-into-journal' | 'distill-to-snap' | 'vision-extract'

interface JournalRequestBody {
  action?: JournalAction
  entryId?: string
  content?: string
  snapIds?: string[]
  imageDataUrl?: string
}

const SKIP_TOKEN = 'SKIP'

const PROMPT_SYSTEM = `You write a single, short journal prompt for a personal journalling app,
based on themes the user has been circling lately. One sentence, warm,
open-ended, never clinical or generic ("How was your day?" is too
generic). It should feel aimed at THIS person's current themes, not
anyone. Respond with ONLY the prompt sentence, nothing else.`

const RESTRUCTURE_PROMPT = `You will be given several standalone notes a user wrote on the same day,
in chronological order. Weave them into one flowing journal entry using
ONLY their own words and phrasing. You may add minimal connective words
("and", "then", "later that day") to make it read smoothly, but you must
never add new ideas, opinions, details, or embellishment that isn't
already in what they wrote. No commentary, no reflection, no advice —
just their own words, restructured into one entry. Respond with ONLY the
entry text, nothing else.`

const DISTILL_PROMPT = `You will be given a full journal entry. Pull out ONE short line (under 20
words) that captures its essence, using the user's own words and phrasing
as much as possible — do not add new ideas or commentary. Respond with
ONLY that one line, nothing else.`

const VISION_EXTRACTION_PROMPT = `This is a screenshot of an Apple Journal entry. Transcribe exactly the
written text content of the entry — the user's own words only. Do not
summarise, do not comment, do not add anything. If a date is visible in
the screenshot, put it on its own first line as "DATE: <the date exactly
as shown>", then a blank line, then the transcribed entry text. If no
date is visible, skip straight to the entry text. Ignore UI chrome
(status bar, app icons, buttons) — only transcribe the journal content
itself.`

// Full Journal mode's optional AI reflection (PRD 5.4): specific to what
// was written, never generic, and the user can skip it. Stores the
// result (or null, if skipped) directly on the journal_entries row.
async function handleReflect(req: VercelRequest, res: VercelResponse, body: JournalRequestBody) {
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
    activeGoals: [],
    upcomingEvents: undefined,
    selfConcept: null,
  }
  const { prompt: systemPrompt } = renderSystemPrompt(bundle)

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
}

// Journal prompt block content (PDF export, "AI content rules"): clearly
// AI-generated, based on current themes — never presented as the user's
// own words.
async function handlePrompt(req: VercelRequest, res: VercelResponse) {
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

  const supabase = createUserScopedClient(accessToken)
  const { data: patterns } = await supabase
    .from('pattern_extractions')
    .select('recurring_themes, emotional_triggers')
    .eq('user_id', user.id)
    .maybeSingle()

  const themes = [...(patterns?.recurring_themes ?? []), ...(patterns?.emotional_triggers ?? [])]
  const themeLine = themes.length > 0 ? themes.join(', ') : 'starting fresh, no strong themes yet'

  const prompt = await callGroq(apiKey, {
    model: GROQ_PRIMARY_MODEL,
    maxTokens: 80,
    temperature: 0.8,
    messages: [
      { role: 'system', content: PROMPT_SYSTEM },
      { role: 'user', content: `Current themes: ${themeLine}` },
    ],
  })
  res.status(200).json({ prompt: prompt.trim() })
}

// "Turn into journal" (PRD 5.4): takes a day's snaps and restructures —
// never rewrites — them into one full journal entry in the user's own
// voice. Critical AI content rule: their words only.
async function handleTurnIntoJournal(req: VercelRequest, res: VercelResponse, body: JournalRequestBody) {
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

  if (!Array.isArray(body.snapIds) || body.snapIds.length === 0) {
    res.status(400).json({ error: '"snapIds" must be a non-empty array' })
    return
  }

  const supabase = createUserScopedClient(accessToken)

  const { data: snaps, error: snapsError } = await supabase
    .from('snaps')
    .select('id, content, created_at')
    .eq('user_id', user.id)
    .in('id', body.snapIds)
    .order('created_at', { ascending: true })

  if (snapsError || !snaps || snaps.length === 0) {
    res.status(404).json({ error: 'No matching snaps found' })
    return
  }

  const combined = snaps.map((s) => `- ${s.content}`).join('\n')
  const entryText = await callGroq(apiKey, {
    model: GROQ_PRIMARY_MODEL,
    maxTokens: 800,
    temperature: 0.3,
    messages: [
      { role: 'system', content: RESTRUCTURE_PROMPT },
      { role: 'user', content: combined },
    ],
  })

  const { data: entry, error: insertError } = await supabase
    .from('journal_entries')
    .insert({
      user_id: user.id,
      mode: 'full',
      content: entryText.trim(),
      source: 'manual',
      entry_date: snaps[0].created_at.slice(0, 10),
    })
    .select('*')
    .single()

  if (insertError || !entry) {
    res.status(500).json({ error: 'Failed to save the new entry' })
    return
  }

  await Promise.allSettled([
    supabase.functions.invoke('embed-entry', {
      body: { userId: user.id, entryId: entry.id, entryType: 'journal_entries', content: entry.content },
    }),
    supabase.functions.invoke('extract-patterns', { body: { userId: user.id, content: entry.content } }),
  ])

  res.status(200).json({ entry })
}

// "Distill to snap" (PRD 5.4): the one-line essence of a long entry,
// pulled from their own words — not an AI summary in a different voice.
async function handleDistillToSnap(req: VercelRequest, res: VercelResponse, body: JournalRequestBody) {
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

  if (typeof body.entryId !== 'string') {
    res.status(400).json({ error: '"entryId" is required' })
    return
  }

  const supabase = createUserScopedClient(accessToken)

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, content')
    .eq('id', body.entryId)
    .eq('user_id', user.id)
    .single()

  if (entryError || !entry) {
    res.status(404).json({ error: 'Entry not found' })
    return
  }

  const distilled = await callGroq(apiKey, {
    model: GROQ_PRIMARY_MODEL,
    maxTokens: 60,
    temperature: 0.3,
    messages: [
      { role: 'system', content: DISTILL_PROMPT },
      { role: 'user', content: entry.content },
    ],
  })

  const { data: snap, error: insertError } = await supabase
    .from('snaps')
    .insert({ user_id: user.id, content: distilled.trim() })
    .select('*')
    .single()

  if (insertError || !snap) {
    res.status(500).json({ error: 'Failed to save the distilled snap' })
    return
  }

  await Promise.allSettled([
    supabase.functions.invoke('embed-entry', {
      body: { userId: user.id, entryId: snap.id, entryType: 'snaps', content: snap.content },
    }),
    supabase.functions.invoke('extract-patterns', { body: { userId: user.id, content: snap.content } }),
  ])

  res.status(200).json({ snap })
}

// Apple Journal screenshot upload (PRD 6.4): reads via Groq vision
// (qwen/qwen3.6-27b), extracts text so the user can review/edit before
// saving it as a real journal entry. Never touches the client with the
// Groq key.
async function handleVisionExtract(req: VercelRequest, res: VercelResponse, body: JournalRequestBody) {
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

  if (typeof body.imageDataUrl !== 'string' || !body.imageDataUrl.startsWith('data:image/')) {
    res.status(400).json({ error: '"imageDataUrl" must be a data:image/... URL' })
    return
  }

  const text = await callGroqVision(apiKey, body.imageDataUrl, VISION_EXTRACTION_PROMPT)

  let date: string | null = null
  let content = text.trim()
  const dateMatch = content.match(/^DATE:\s*(.+)$/m)
  if (dateMatch) {
    date = dateMatch[1].trim()
    content = content.slice(dateMatch.index! + dateMatch[0].length).trim()
  }

  res.status(200).json({ content, date })
}

// Consolidated journal endpoint (Vercel Hobby plan's 12-function cap, see
// README): every journal-related AI action — optional reflection, an
// export-builder prompt, restructuring snaps into an entry or an entry
// into a snap, and Apple Journal screenshot OCR — routed by a body
// `action` field, since all five are POSTs from our own frontend that can
// each carry one.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as JournalRequestBody

  try {
    switch (body.action) {
      case 'reflect':
        await handleReflect(req, res, body)
        return
      case 'prompt':
        await handlePrompt(req, res)
        return
      case 'turn-into-journal':
        await handleTurnIntoJournal(req, res, body)
        return
      case 'distill-to-snap':
        await handleDistillToSnap(req, res, body)
        return
      case 'vision-extract':
        await handleVisionExtract(req, res, body)
        return
      default:
        res.status(400).json({ error: 'Unknown or missing "action"' })
    }
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's or
    // createUserScopedClient's Supabase client to throw, a network
    // hiccup, etc.) must still come back as JSON — an uncaught throw here
    // becomes Vercel's own plain-text crash page, which breaks every
    // client-side `response.json()` call.
    console.error(`journal (action=${body.action}) failed`, err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
