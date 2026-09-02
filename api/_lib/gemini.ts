// Thin wrapper around Google AI Studio's Gemini API — the main-model
// provider for chat responses (PRD v1.6 provider switch). Groq's free-tier
// 8,000 TPM ceiling turned out to be structurally unworkable for this
// app's injected-context size: the system prompt alone is ~2,880 tokens
// before any memory or conversation history is added, so no amount of
// per-section trimming got the full request under the limit. Gemini
// has a 1M token context window and a much more generous free tier, so
// the main response call moves here entirely. The conversation analyzer
// pre-call stays on Groq (openai/gpt-oss-20b) — its own token footprint
// was never the problem.
//
// gemini-1.5-flash was retired by Google (the whole 1.5 family now 404s
// on generateContent) — pinned to the current GA flash-tier model
// instead. Google's own guidance is to pin an explicit stable model
// name in production rather than a `-latest` alias (which can hot-swap
// underlying behavior without a code change), so expect to need to bump
// this again whenever Google retires this one too — check
// https://ai.google.dev/gemini-api/docs/models for the current GA name
// if this starts 404ing again.
import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai'

const GEMINI_MODEL = 'gemini-3.7-flash'

// Google's API returns 503 ("This model is currently experiencing high
// demand... try again later") fairly routinely, and 429 for genuine rate
// limiting — both are usually gone within a couple of seconds, so one
// retry after a short pause turns most of these into a slightly slower
// success instead of a failed turn.
const RETRYABLE_STATUS_CODES = new Set([429, 503])
const RETRY_DELAY_MS = 1500

export interface GeminiMessage {
  role: 'user' | 'assistant'
  content: string
}

interface CallGeminiOptions {
  systemPrompt: string
  messages: GeminiMessage[]
  maxTokens?: number
  temperature?: number
}

interface GeminiHistoryTurn {
  role: 'user' | 'model'
  parts: { text: string }[]
}

// Gemini's chat API requires history to start with a 'user' turn and
// strictly alternate user/model from there — Groq's plain messages array
// never enforced either, so this app's stored history can violate both:
// a turn whose model call failed after the user's message was already
// inserted (chat.ts's insert_user_message stage) but before a reply got
// saved leaves an orphaned user row, so the next real turn lands right
// after it as a second consecutive user row; and whatever this
// particular account's very oldest chat_history row turns out to be
// could be an assistant message with nothing before it. Drop any turns
// before the first 'user' turn, then coalesce consecutive same-role
// turns into one so the result always alternates.
function toGeminiHistory(messages: GeminiMessage[]): GeminiHistoryTurn[] {
  const startIndex = messages.findIndex((m) => m.role === 'user')
  const fromFirstUserTurn = startIndex === -1 ? [] : messages.slice(startIndex)

  const history: GeminiHistoryTurn[] = []
  for (const m of fromFirstUserTurn) {
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user'
    const last = history[history.length - 1]
    if (last && last.role === role) {
      last.parts[0].text += `\n\n${m.content}`
    } else {
      history.push({ role, parts: [{ text: m.content }] })
    }
  }
  return history
}

export async function callGemini({
  systemPrompt,
  messages,
  maxTokens = 1000,
  temperature = 0.9,
}: CallGeminiOptions): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY is not configured on the server')
  }
  if (messages.length === 0) {
    throw new Error('callGemini requires at least one message')
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  })

  // Gemini's chat history takes every turn except the last as context, and
  // the last one as the message being sent — the same shape callGroq's
  // messages array had (system prompt aside, which Gemini takes out of
  // band via systemInstruction rather than as a message in this list).
  const history = toGeminiHistory(messages.slice(0, -1))

  const lastMessage = messages[messages.length - 1].content

  const chat = model.startChat({ history })
  try {
    const result = await chat.sendMessage(lastMessage)
    return result.response.text()
  } catch (err) {
    if (!(err instanceof GoogleGenerativeAIFetchError) || err.status === undefined || !RETRYABLE_STATUS_CODES.has(err.status)) {
      throw err
    }
    console.error(`Gemini request failed with a transient ${err.status}, retrying once after ${RETRY_DELAY_MS}ms`, err.message)
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    const result = await chat.sendMessage(lastMessage)
    return result.response.text()
  }
}
