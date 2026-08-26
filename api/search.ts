import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'

interface SearchRequestBody {
  query?: string
}

interface TavilyResult {
  title: string
  url: string
  content: string
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

const MAX_RESULTS = 5

// Web search for chat (PRD 5.3 "Web search — confirm bubble"). Never
// called automatically — the client only hits this after the user taps
// [Search] on the confirm bubble the intent classifier triggered.
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

  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'TAVILY_API_KEY is not configured on the server' })
    return
  }

  const body = req.body as SearchRequestBody
  if (typeof body.query !== 'string' || !body.query.trim()) {
    res.status(400).json({ error: '"query" must be a non-empty string' })
    return
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: body.query,
        include_answer: true,
        max_results: MAX_RESULTS,
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      res.status(502).json({ error: 'Tavily request failed', detail })
      return
    }

    const data = (await response.json()) as TavilyResponse

    const summaryParts: string[] = []
    if (data.answer) summaryParts.push(data.answer)
    for (const result of data.results ?? []) {
      summaryParts.push(`${result.title}: ${result.content}`.trim())
    }

    res.status(200).json({ summary: summaryParts.join('\n\n') || 'No results found.' })
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error calling Tavily', detail: String(err) })
  }
}
