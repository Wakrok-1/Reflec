import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GROQ_PRIMARY_MODEL } from './_lib/groq'

interface TurnIntoJournalBody {
  snapIds?: string[]
}

const RESTRUCTURE_PROMPT = `You will be given several standalone notes a user wrote on the same day,
in chronological order. Weave them into one flowing journal entry using
ONLY their own words and phrasing. You may add minimal connective words
("and", "then", "later that day") to make it read smoothly, but you must
never add new ideas, opinions, details, or embellishment that isn't
already in what they wrote. No commentary, no reflection, no advice —
just their own words, restructured into one entry. Respond with ONLY the
entry text, nothing else.`

// "Turn into journal" (PRD 5.4): takes a day's snaps and restructures —
// never rewrites — them into one full journal entry in the user's own
// voice. Critical AI content rule: their words only.
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

  const body = req.body as TurnIntoJournalBody
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

  try {
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
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error calling Groq API', detail: String(err) })
  }
}
