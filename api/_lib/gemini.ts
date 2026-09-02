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
import { GoogleGenerativeAI } from '@google/generative-ai'

const GEMINI_MODEL = 'gemini-3.7-flash'

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
  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const lastMessage = messages[messages.length - 1].content

  const chat = model.startChat({ history })
  const result = await chat.sendMessage(lastMessage)
  return result.response.text()
}
