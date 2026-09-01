import { callGroq, GROQ_CLASSIFIER_MODEL, type GroqMessage } from './groq'

// The Conversation Engine's analyzer pre-call (PRD v1.6 7.0): a fast
// gpt-oss-20b pass that decides HOW Your Reflection should respond — not
// what to say, just the shape of the response — before the single main
// gpt-oss-120b call. Exactly one analyzer call + one main-model call per
// message (occasionally a second main-model call if the therapy-speak
// filter rejects the first) — the Groq free tier's request-per-day cap
// is the reason this stays at 2 calls, not 6.

export type ConversationalMove =
  | 'REACT'
  | 'REFLECT'
  | 'RELATE'
  | 'CHALLENGE'
  | 'SHARE'
  | 'PLAY'
  | 'EXPLORE'
  | 'SILENCE'
  | 'VALIDATE'
  | 'CALLBACK'
export type ResponseLength = 'tiny' | 'short' | 'medium' | 'long'
export type UserIntent =
  | 'VENT'
  | 'STORYTELLING'
  | 'SEEKING_VALIDATION'
  | 'SEEKING_ADVICE'
  | 'CELEBRATING'
  | 'JOKING'
  | 'CASUAL_CHAT'
  | 'REFLECTING'
  | 'UNCERTAIN'
export type Stance = 'agree' | 'disagree' | 'neutral' | 'uncertain'

// PRD v1.6's "appraisal layer" upgrade: an emotion label alone ("sad",
// "anxious") doesn't tell the main model WHY it matters to this person —
// appraisal, intent, and stance exist so the response can react to the
// actual stakes instead of the label. recent_move_penalty carries forward
// what the [CONVERSATION POLICY]'s "track your question usage, don't
// repeat yourself" guidance already asks for, but computed here instead
// of left to the main model to notice on its own.
export interface ConversationAnalysis {
  conversational_move: ConversationalMove
  intent: UserIntent
  emotion: string
  appraisal: string
  question_budget: 0 | 1
  response_length: ResponseLength
  multi_message: boolean
  message_count: number
  recent_move_penalty: string
  stance: Stance
}

const MOVES: ConversationalMove[] = [
  'REACT',
  'REFLECT',
  'RELATE',
  'CHALLENGE',
  'SHARE',
  'PLAY',
  'EXPLORE',
  'SILENCE',
  'VALIDATE',
  'CALLBACK',
]
const LENGTHS: ResponseLength[] = ['tiny', 'short', 'medium', 'long']
const INTENTS: UserIntent[] = [
  'VENT',
  'STORYTELLING',
  'SEEKING_VALIDATION',
  'SEEKING_ADVICE',
  'CELEBRATING',
  'JOKING',
  'CASUAL_CHAT',
  'REFLECTING',
  'UNCERTAIN',
]
const STANCES: Stance[] = ['agree', 'disagree', 'neutral', 'uncertain']

// Used both when the analyzer call fails outright and as the sanitizer's
// per-field fallback. question_budget: 0 (not 1) is deliberate — if the
// analyzer is unavailable, defaulting to "ask a question" is exactly the
// questionnaire-like behavior this engine exists to prevent.
const DEFAULT_ANALYSIS: ConversationAnalysis = {
  conversational_move: 'REFLECT',
  intent: 'UNCERTAIN',
  emotion: 'neutral',
  appraisal: 'unknown — analyzer unavailable, do not over-interpret',
  question_budget: 0,
  response_length: 'short',
  multi_message: false,
  message_count: 1,
  recent_move_penalty: 'none',
  stance: 'neutral',
}

const ANALYZER_PROMPT = `You are a fast pre-call that decides HOW Your Reflection (a personal AI
companion) should respond — not what to say, just the shape of the
response. Analyze the user's latest message against the recent
conversation.

Respond with ONLY the following — no text before it, no text after it,
no markdown fence around it:

<analysis>
{
  "conversational_move": "REACT" | "REFLECT" | "RELATE" | "CHALLENGE" | "SHARE" | "PLAY" | "EXPLORE" | "SILENCE" | "VALIDATE" | "CALLBACK",
  "intent": "VENT" | "STORYTELLING" | "SEEKING_VALIDATION" | "SEEKING_ADVICE" | "CELEBRATING" | "JOKING" | "CASUAL_CHAT" | "REFLECTING" | "UNCERTAIN",
  "emotion": "frustrated" | "sad" | "happy" | "anxious" | "neutral" | "excited" | "tired",
  "appraisal": "string, 10 WORDS MAXIMUM — why this situation matters emotionally, what expectation was violated or threatened",
  "question_budget": 0 | 1,
  "response_length": "tiny" | "short" | "medium" | "long",
  "multi_message": boolean,
  "message_count": 1 | 2 | 3,
  "recent_move_penalty": "string, 5 WORDS MAXIMUM — conversational_move values used in the last 3 assistant turns, so the main model doesn't repeat itself; \\"none\\" if there's no history yet",
  "stance": "agree" | "disagree" | "neutral" | "uncertain"
}
</analysis>

Everything between <analysis> and </analysis> must be that one JSON
object and nothing else.

Appraisal is the most important field. It is not the emotion label — it's
WHY the situation matters to this person, what expectation got violated
or threatened, what's actually at stake. Never invent detail that isn't
there; when the message is too short or ambiguous to know, say so rather
than guessing. appraisal MUST be 10 words maximum — be extremely
concise, a fragment, not a sentence. Examples (each already at or under
the 10-word limit):
- "my manager criticised me in front of everyone" -> appraisal: "expected to look competent, public humiliation threatens that"
- "i feel scared going home" -> appraisal: "home means threat or judgment, alone feels safer"
- "tired" -> appraisal: "unknown, don't over-interpret one word"
- "I finally finished that project" -> appraisal: "effort paid off, means relief and validation"

Rules:
- question_budget: 0 when the user is venting, sharing something casual, or questions were already asked in the last few turns.
- multi_message: default to true whenever what you'd say naturally splits into two beats, the way a person actually texts instead of writing one paragraph. This is not limited to REACT or PLAY — REFLECT and RELATE qualify just as often (a reaction then an observation, an observation then a callback). Set it true for: excited or big news, casual back-and-forth, any reply where a natural sentence break exists between two separate thoughts. Only keep it false for a single, indivisible thought — one short reaction, one direct answer, a tiny/passing exchange, or a heavy/serious moment that calls for one held statement instead of being split up.
- message_count is 1-3, usually 2 when multi_message is true.
- response_length: "tiny" for casual/passing messages like "im going home tonight".
- SILENCE means respond with one short statement, no question, no follow-up.
- VALIDATE: the user needs their experience confirmed as real and reasonable, without clinical language ("your feelings are valid" is banned phrasing, not a VALIDATE move).
- CALLBACK: bring up something from earlier in the conversation or from memory yourself, unprompted — this is what makes it feel two-way.
- stance: your own honest read, not a wishy-washy default. Use "neutral"/"uncertain" only when there genuinely isn't a side to take.
- recent_move_penalty: read the assistant's last 3 turns in the conversation you're given and name which conversational_move each one most likely was, so the same move isn't repeated a fourth time. "none" if there isn't 3 turns of history yet. MUST be 5 words maximum — move names only (e.g. "REACT, REFLECT" not a sentence about them).

Keep every field short, especially appraisal (10 words max) and
recent_move_penalty (5 words max) — this schema has 10 fields, and a
verbose free-text field is what runs the response past max_tokens
before the JSON can close.`

// Pulls the JSON object out of the <analysis>...</analysis> tags the
// prompt asks for.
//
// A response truncated by max_tokens never gets to emit the closing
// </analysis> tag at all — so the closing-tag regex won't match, and the
// content to parse is "everything after <analysis>", not "everything
// between the two tags". Falling back to the raw string in that case
// (rather than stripping the opening tag) would just hand JSON.parse a
// string starting with a literal `<`, which no brace-repair can fix.
function stripAnalysisTags(raw: string): string {
  const closed = raw.match(/<analysis>([\s\S]*?)<\/analysis>/i)
  if (closed) return closed[1].trim()
  const openOnly = raw.match(/<analysis>([\s\S]*)$/i)
  return (openOnly ? openOnly[1] : raw).trim()
}

// Most truncation cases (max_tokens hit mid-generation) cut off after the
// last field's closing quote, one character short of a valid document —
// the object is otherwise well-formed, it's just missing its final `}`.
// Rather than let that fail JSON.parse outright and fall all the way
// back to DEFAULT_ANALYSIS, try once with a `}` appended before giving
// up — a cheap repair that recovers the real analysis in the common
// truncation case instead of discarding it.
function extractAnalysisJson(raw: string): unknown {
  const jsonText = stripAnalysisTags(raw)
  try {
    return JSON.parse(jsonText)
  } catch (err) {
    if (jsonText.endsWith('}')) throw err
    return JSON.parse(`${jsonText}}`)
  }
}

function clampMessageCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  const n = Number.isFinite(parsed) ? Math.round(parsed) : 1
  return Math.min(3, Math.max(1, n))
}

function sanitize(raw: unknown): ConversationAnalysis {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const move = MOVES.includes(obj.conversational_move as ConversationalMove)
    ? (obj.conversational_move as ConversationalMove)
    : DEFAULT_ANALYSIS.conversational_move

  // SILENCE always has question_budget 0, regardless of what the model
  // returned (PRD 7.0: "SILENCE move always has question_budget = 0").
  const questionBudget = move === 'SILENCE' ? 0 : obj.question_budget === 0 ? 0 : obj.question_budget === 1 ? 1 : 1

  return {
    conversational_move: move,
    intent: INTENTS.includes(obj.intent as UserIntent) ? (obj.intent as UserIntent) : DEFAULT_ANALYSIS.intent,
    emotion: typeof obj.emotion === 'string' && obj.emotion.trim() ? obj.emotion : DEFAULT_ANALYSIS.emotion,
    appraisal:
      typeof obj.appraisal === 'string' && obj.appraisal.trim() ? obj.appraisal.trim() : DEFAULT_ANALYSIS.appraisal,
    question_budget: questionBudget,
    response_length: LENGTHS.includes(obj.response_length as ResponseLength)
      ? (obj.response_length as ResponseLength)
      : DEFAULT_ANALYSIS.response_length,
    multi_message: obj.multi_message === true || obj.multi_message === 'true',
    message_count: clampMessageCount(obj.message_count),
    recent_move_penalty:
      typeof obj.recent_move_penalty === 'string' && obj.recent_move_penalty.trim()
        ? obj.recent_move_penalty.trim()
        : DEFAULT_ANALYSIS.recent_move_penalty,
    stance: STANCES.includes(obj.stance as Stance) ? (obj.stance as Stance) : DEFAULT_ANALYSIS.stance,
  }
}

// Defense in depth for the "last 3 turns already had questions" rule:
// rather than trusting the analyzer to have counted correctly, check the
// actual recent assistant turns and force the budget to 0 if any asked
// something. Never raises the budget — only ever tightens it.
function enforceRecentQuestionRule(analysis: ConversationAnalysis, recentMessages: GroqMessage[]): ConversationAnalysis {
  const recentAssistantTurns = recentMessages.filter((m) => m.role === 'assistant').slice(-3)
  const askedRecently = recentAssistantTurns.some((m) => m.content.includes('?'))
  if (askedRecently && analysis.question_budget !== 0) {
    return { ...analysis, question_budget: 0 }
  }
  return analysis
}

// Analyzes the user's latest message and recent context. Fails open to a
// safe, moderate default (matching classify-intent.ts's own fail-open
// pattern) rather than ever blocking the main chat call.
//
// Deliberately NOT using jsonMode/response_format: json_object here —
// Groq's grammar-constrained JSON mode was throwing
// json_validate_failed: max completion tokens reached before generating
// a valid document whenever the 10-field schema (with a free-text
// appraisal sentence) ran the constrained decoder past max_tokens before
// it could close its braces, which is a hard 400 from Groq itself, not
// something try/catch here ever got a chance to handle gracefully.
// Free-form generation into <analysis> tags plus our own tolerant
// extractAnalysisJson() below means a truncated or slightly malformed
// response just fails JSON.parse and falls through to DEFAULT_ANALYSIS,
// instead of failing the whole Groq request.
//
// reasoningEffort: 'low' is the actual fix for the failure mode that
// showed up after the above: raw coming back completely EMPTY (not
// truncated JSON) with "Unexpected end of JSON input" / a repair attempt
// throwing on a bare "}" — because gpt-oss's default ("medium") reasoning
// effort burns the whole max_tokens budget on its internal
// chain-of-thought trace before ever reaching the final answer channel,
// a documented behavior for gpt-oss-20b/120b on Groq (and reproduced
// independently on other inference backends). This classification task
// doesn't need deep reasoning, so 'low' leaves the budget for the answer.
export async function analyzeConversation(apiKey: string, recentMessages: GroqMessage[]): Promise<ConversationAnalysis> {
  try {
    const raw = await callGroq(apiKey, {
      model: GROQ_CLASSIFIER_MODEL,
      maxTokens: 1000,
      temperature: 0,
      reasoningEffort: 'low',
      messages: [{ role: 'system', content: ANALYZER_PROMPT }, ...recentMessages],
    })
    // TEMP DEBUG (analyzer truncation investigation) — remove once confirmed.
    console.log('ANALYZER RAW OUTPUT:', raw)
    const parsed = extractAnalysisJson(raw)
    return enforceRecentQuestionRule(sanitize(parsed), recentMessages)
  } catch (err) {
    console.error('conversation analyzer failed, falling back to default analysis', err)
    return enforceRecentQuestionRule(DEFAULT_ANALYSIS, recentMessages)
  }
}

// "[CONVERSATION DIRECTIVE — follow exactly, overrides general rules for
// this response]" block, injected as its own system message right before
// the user's messages (PRD 7.0 / v1.6 appraisal layer).
export function buildConversationDirective(analysis: ConversationAnalysis): string {
  return `[CONVERSATION DIRECTIVE — follow exactly, overrides general rules for this response]
Move: ${analysis.conversational_move}
Length: ${analysis.response_length}
Questions allowed: ${analysis.question_budget} maximum
Multi-message: ${analysis.multi_message} — if true, return a JSON array of ${analysis.message_count} separate messages
Emotion: ${analysis.emotion}
Appraisal: ${analysis.appraisal}
Intent: ${analysis.intent}
Stance: ${analysis.stance}
Avoid these recent moves: ${analysis.recent_move_penalty}`
}

// The instruction that tells the main model to reply as a JSON array of
// separate texts instead of one block, when the analyzer called for it.
// Pulled out so api/chat.ts and the api/health.ts conversation-debug
// action build the exact same context, not two copies that can drift.
export function buildMultiMessageInstruction(analysis: ConversationAnalysis): string {
  return `Respond with ONLY a JSON object: {"messages": [{"text": string, "delay": number}]} — exactly ${analysis.message_count} messages, delays in milliseconds increasing from 0 (e.g. 0, 800, 1600), each a short separate text as if sent one after another like real texts.`
}
