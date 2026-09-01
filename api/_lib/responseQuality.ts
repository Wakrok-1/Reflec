// Response-shape parsing and quality scoring for the single main-model
// call in api/chat.ts (PRD v1.6). This used to also house 3-candidate
// generation + a gpt-oss-20b ranker call, but that cost 4 extra Groq
// calls per message against a free-tier budget of 1,000 requests/day —
// removed entirely in favor of one main-model call, with the
// therapy-speak filter (string scoring, no API call) as the only
// remaining quality gate.

interface ParsedMultiMessage {
  text: string
  delay: number
}

// Tolerant parse of the multi-message JSON shape the main model is asked
// for when analysis.multi_message is true — accepts a bare array instead
// of {"messages": [...]}, or a "message"/"content" key instead of "text",
// and falls back to treating the whole raw string as one message if the
// JSON doesn't parse at all.
export function parseMultiMessageJson(raw: string): ParsedMultiMessage[] {
  let parsedMessages: ParsedMultiMessage[] = []
  try {
    const parsed: unknown = JSON.parse(raw)
    const list: unknown = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown })?.messages
    if (Array.isArray(list)) {
      parsedMessages = list
        .map((m) => {
          if (typeof m === 'string') return { text: m, delay: undefined as unknown }
          if (!m || typeof m !== 'object') return null
          const obj = m as Record<string, unknown>
          const text = obj.text ?? obj.message ?? obj.content
          return typeof text === 'string' ? { text, delay: obj.delay } : null
        })
        .filter((m): m is { text: string; delay: unknown } => !!m && m.text.trim().length > 0)
        .slice(0, 3)
        .map((m, i) => ({
          text: m.text.trim(),
          delay: typeof m.delay === 'number' && Number.isFinite(m.delay) ? m.delay : i * 800,
        }))
    }
  } catch {
    // Malformed multi-message JSON — fall back to the raw text as one
    // message rather than failing the whole request over response shape.
  }
  if (parsedMessages.length === 0) {
    parsedMessages = [{ text: raw.trim(), delay: 0 }]
  }
  return parsedMessages
}

// Plain-text form of a response, used for therapy-speak scoring — for a
// multi-message response this is its bubbles joined, not the raw JSON
// (scoring raw JSON would miss "starts with" checks and double-count
// phrases inside quoted strings).
export function extractPlainText(raw: string, multiMessage: boolean): string {
  if (!multiMessage) return raw.trim()
  return parseMultiMessageJson(raw)
    .map((m) => m.text)
    .join('\n\n')
}

// Therapy-speak post-filter (PRD v1.6): scores generated
// performed-empathy boilerplate via plain string matching, no extra API
// call. THERAPY_SPEAK_THRESHOLD (>= 4) is "too therapeutic" — regenerate
// once with a stronger directive instead of sending it.
export const THERAPY_SPEAK_THRESHOLD = 4

const THERAPY_SPEAK_RULES: { test: (lower: string) => boolean; points: number }[] = [
  { test: (t) => t.trimStart().startsWith('i hear'), points: 3 },
  { test: (t) => t.includes('it sounds like'), points: 2 },
  { test: (t) => t.includes('it feels like you'), points: 2 },
  { test: (t) => t.includes("i'm noticing") || t.includes('i am noticing'), points: 2 },
  { test: (t) => t.includes('sitting with'), points: 1 },
  { test: (t) => t.includes("what's coming up for you") || t.includes('what is coming up for you'), points: 2 },
  { test: (t) => t.includes('your feelings are valid'), points: 3 },
  { test: (t) => t.includes('take some time'), points: 1 },
  { test: (t) => t.includes('that must be'), points: 1 },
]

export function scoreTherapySpeak(text: string): number {
  const lower = text.toLowerCase()
  return THERAPY_SPEAK_RULES.reduce((score, rule) => score + (rule.test(lower) ? rule.points : 0), 0)
}
