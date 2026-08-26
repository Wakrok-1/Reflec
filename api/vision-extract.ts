import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { callGroqVision } from './_lib/groq'

interface VisionExtractBody {
  imageDataUrl?: string
}

const EXTRACTION_PROMPT = `This is a screenshot of an Apple Journal entry. Transcribe exactly the
written text content of the entry — the user's own words only. Do not
summarise, do not comment, do not add anything. If a date is visible in
the screenshot, put it on its own first line as "DATE: <the date exactly
as shown>", then a blank line, then the transcribed entry text. If no
date is visible, skip straight to the entry text. Ignore UI chrome
(status bar, app icons, buttons) — only transcribe the journal content
itself.`

// Apple Journal screenshot upload (PRD 6.4): reads via Groq vision
// (qwen/qwen3.6-27b), extracts text so the user can review/edit before
// saving it as a real journal entry. Never touches the client with the
// Groq key.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  let user
  try {
    user = await verifyUser(req.headers.authorization)
  } catch (err) {
    console.error('vision-extract auth check failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
    return
  }
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' })
    return
  }

  const body = req.body as VisionExtractBody
  if (typeof body.imageDataUrl !== 'string' || !body.imageDataUrl.startsWith('data:image/')) {
    res.status(400).json({ error: '"imageDataUrl" must be a data:image/... URL' })
    return
  }

  try {
    const text = await callGroqVision(apiKey, body.imageDataUrl, EXTRACTION_PROMPT)

    let date: string | null = null
    let content = text.trim()
    const dateMatch = content.match(/^DATE:\s*(.+)$/m)
    if (dateMatch) {
      date = dateMatch[1].trim()
      content = content.slice(dateMatch.index! + dateMatch[0].length).trim()
    }

    res.status(200).json({ content, date })
  } catch (err) {
    res.status(500).json({ error: 'Vision extraction failed', detail: String(err) })
  }
}
