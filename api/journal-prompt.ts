import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { callGroq, GROQ_PRIMARY_MODEL } from './_lib/groq'

const PROMPT_SYSTEM = `You write a single, short journal prompt for a personal journalling app,
based on themes the user has been circling lately. One sentence, warm,
open-ended, never clinical or generic ("How was your day?" is too
generic). It should feel aimed at THIS person's current themes, not
anyone. Respond with ONLY the prompt sentence, nothing else.`

// Journal prompt block content (PDF export, "AI content rules"): clearly
// AI-generated, based on current themes — never presented as the user's
// own words.
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
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's or
    // createUserScopedClient's Supabase client to throw, a network
    // hiccup, etc.) must still come back as JSON — an uncaught throw here
    // becomes Vercel's own plain-text crash page, which breaks every
    // client-side `response.json()` call.
    console.error('journal-prompt failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
