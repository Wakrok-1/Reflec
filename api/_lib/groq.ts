// Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
// PRD v1.3 section 4: primary model openai/gpt-oss-120b, fallback
// openai/gpt-oss-20b if the primary hits rate limits.

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

export const GROQ_PRIMARY_MODEL = 'openai/gpt-oss-120b'
export const GROQ_FALLBACK_MODEL = 'openai/gpt-oss-20b'
export const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b'

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface CallGroqOptions {
  model?: string
  messages: GroqMessage[]
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
}

export class GroqError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    super(`Groq API request failed (${status})`)
    this.status = status
    this.detail = detail
  }
}

async function requestGroq(apiKey: string, model: string, options: CallGroqOptions) {
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.7,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new GroqError(response.status, detail)
  }

  const data = await response.json()
  const text: string | undefined = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') {
    throw new GroqError(502, 'Groq response had no message content')
  }
  return text
}

// Calls the primary model, and falls back to the smaller/faster model on a
// 429 (rate limit) as described in the PRD's free-tier cost note.
export async function callGroq(apiKey: string, options: CallGroqOptions) {
  const model = options.model ?? GROQ_PRIMARY_MODEL
  try {
    return await requestGroq(apiKey, model, options)
  } catch (err) {
    if (err instanceof GroqError && err.status === 429 && model !== GROQ_FALLBACK_MODEL) {
      return await requestGroq(apiKey, GROQ_FALLBACK_MODEL, options)
    }
    throw err
  }
}
