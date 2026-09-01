import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { callGroq } from './_lib/groq'

// Sprint 0 connectivity check: confirms GROQ_API_KEY is wired up and the
// model actually responds. Not the real chat endpoint (that's api/chat.ts
// with full memory injection) — this just proves the pipe works end to
// end: browser -> this function -> Groq.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
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

    const message = await callGroq(apiKey, {
      maxTokens: 64,
      messages: [
        {
          role: 'user',
          content:
            'Reply with exactly one short sentence confirming you are online and ready, as Your Reflection.',
        },
      ],
    })
    res.status(200).json({ ok: true, message })
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's Supabase
    // client to throw, a network hiccup, etc.) must still come back as
    // JSON — an uncaught throw here becomes Vercel's own plain-text crash
    // page, which breaks every client-side `response.json()` call.
    console.error('health failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
