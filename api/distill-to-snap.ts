import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GROQ_PRIMARY_MODEL } from './_lib/groq'

interface DistillBody {
  entryId?: string
}

const DISTILL_PROMPT = `You will be given a full journal entry. Pull out ONE short line (under 20
words) that captures its essence, using the user's own words and phrasing
as much as possible — do not add new ideas or commentary. Respond with
ONLY that one line, nothing else.`

// "Distill to snap" (PRD 5.4): the one-line essence of a long entry,
// pulled from their own words — not an AI summary in a different voice.
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

    const body = req.body as DistillBody
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
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's or
    // createUserScopedClient's Supabase client to throw, a network
    // hiccup, etc.) must still come back as JSON — an uncaught throw here
    // becomes Vercel's own plain-text crash page, which breaks every
    // client-side `response.json()` call.
    console.error('distill-to-snap failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
