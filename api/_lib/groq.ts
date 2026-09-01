// Thin wrapper around Groq's OpenAI-compatible chat completions endpoint.
// PRD v1.3 section 4: primary model openai/gpt-oss-120b, fallback
// openai/gpt-oss-20b if the primary hits rate limits.

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

export const GROQ_PRIMARY_MODEL = 'openai/gpt-oss-120b'
export const GROQ_FALLBACK_MODEL = 'openai/gpt-oss-20b'
export const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b'
// Same model as the fallback, used here for its speed rather than as a
// fallback path — the intent classifier pre-check (PRD 5.3) needs to be
// fast and cheap, not the most capable model.
export const GROQ_CLASSIFIER_MODEL = 'openai/gpt-oss-20b'

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
  // gpt-oss models (both the 20b classifier and 120b primary) generate a
  // separate internal chain-of-thought "reasoning" trace before the final
  // answer, and that reasoning counts against max_tokens — the default
  // effort ("medium") can burn the whole budget reasoning and leave
  // message.content completely empty, not truncated, with no error from
  // Groq at all (a documented gpt-oss behavior, reproduced independently
  // on other inference backends too). 'low' leaves far more of the
  // budget for the actual answer on a call that doesn't need deep
  // reasoning. Groq's `reasoning_format` param is explicitly NOT
  // supported for gpt-oss-20b/120b, so this is the only lever available.
  reasoningEffort?: 'low' | 'medium' | 'high'
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
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new GroqError(response.status, detail)
  }

  const data = await response.json()
  const choice = data?.choices?.[0]
  const text: string | undefined = choice?.message?.content
  // Empty (not just non-string) content is the gpt-oss "spent the whole
  // max_tokens budget reasoning" failure mode described above — Groq
  // still returns 200 OK with a normal-looking response shape, so this
  // has to be checked explicitly rather than relying on the !ok branch
  // above to ever catch it.
  if (typeof text !== 'string' || text.trim().length === 0) {
    // reasoningEffort: 'low' alone didn't fix this in production — logging
    // finish_reason/usage/the model's own reasoning field (if Groq sent
    // one) here, at the actual point of failure, instead of guessing at
    // another parameter blind. finish_reason "length" + completion_tokens
    // at the max confirms token exhaustion; a populated `reasoning` field
    // shows what the model spent the budget on and whether 'low' effort
    // is actually being honored at all.
    console.error('Groq returned no message content', {
      model,
      finish_reason: choice?.finish_reason,
      usage: data?.usage,
      message: choice?.message,
    })
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

// Streaming variant for the main chat route — returns the raw response so
// the caller can pipe Groq's SSE stream straight through to the browser
// instead of waiting for the full completion.
export async function streamGroq(apiKey: string, options: CallGroqOptions): Promise<Response> {
  const model = options.model ?? GROQ_PRIMARY_MODEL
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 800,
      temperature: options.temperature ?? 0.8,
      stream: true,
    }),
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new GroqError(response.status, detail)
  }

  return response
}

// Vision call for Apple Journal screenshot extraction (PRD 6.4). Separate
// from callGroq because multimodal content is a different shape (an array
// of text/image_url parts) than the plain-string messages used everywhere
// else, and this is the only place in the app that needs it.
export async function callGroqVision(apiKey: string, imageDataUrl: string, prompt: string): Promise<string> {
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      max_tokens: 1000,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new GroqError(response.status, detail)
  }

  const data = await response.json()
  const text: string | undefined = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') {
    throw new GroqError(502, 'Groq vision response had no message content')
  }
  return text
}

// Parses one line of a Groq/OpenAI-style SSE stream ("data: {...}" or
// "data: [DONE]") and extracts the text delta, if any.
export function parseGroqStreamLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload)
    const delta: string | undefined = parsed?.choices?.[0]?.delta?.content
    return typeof delta === 'string' ? delta : null
  } catch {
    return null
  }
}
