import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'

// Sprint 0 connectivity check: confirms the ANTHROPIC_API_KEY env var is
// wired up and Claude actually responds. Not the real chat endpoint
// (that lands in Sprint 2 with memory injection) — this just proves the
// pipe works end to end: browser -> this function -> Claude API.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const user = await verifyUser(req.headers.authorization)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' })
    return
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content:
              'Reply with exactly one short sentence confirming you are online and ready, as Your Reflection.',
          },
        ],
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      res.status(502).json({ error: 'Claude API request failed', detail })
      return
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text ?? null

    res.status(200).json({ ok: true, message: text })
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error calling Claude API', detail: String(err) })
  }
}
