import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { callGroq, type GroqMessage } from './_lib/groq'
import { buildOnboardingSystemPrompt } from './_lib/systemPrompt'

interface OnboardingChatBody {
  messages?: GroqMessage[]
}

// One turn of the onboarding AI interview (PRD 5.1). Stateless — the
// client sends the full conversation so far, this returns Your
// Reflection's next message. No memory injection yet; the interview
// itself is what Sprint 1 uses to seed memory (see onboarding-finalize).
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

    const body = req.body as OnboardingChatBody
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: '"messages" must be a non-empty array' })
      return
    }

    const reply = await callGroq(apiKey, {
      maxTokens: 400,
      temperature: 0.8,
      messages: [{ role: 'system', content: buildOnboardingSystemPrompt() }, ...body.messages],
    })
    res.status(200).json({ reply })
  } catch (err) {
    // Anything unexpected (a bad env var causing verifyUser's Supabase
    // client to throw, a network hiccup, etc.) must still come back as
    // JSON — an uncaught throw here becomes Vercel's own plain-text crash
    // page, which breaks every client-side `response.json()` call.
    console.error('onboarding-chat failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
