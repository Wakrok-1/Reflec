import { callGroq, GROQ_CLASSIFIER_MODEL, type GroqMessage } from './groq'

// The Conversation Engine's analyzer pre-call (PRD 7.0): a fast gpt-oss-20b
// pass that decides HOW Your Reflection should respond — not what to say,
// just the shape of the response — before the main gpt-oss-120b call.

export type ConversationalMove = 'REACT' | 'REFLECT' | 'RELATE' | 'CHALLENGE' | 'SHARE' | 'PLAY' | 'EXPLORE' | 'SILENCE'
export type ResponseLength = 'tiny' | 'short' | 'medium' | 'long'

// Trimmed to only the fields the directive actually uses. user_intent,
// advice_wanted, can_reference_past, and can_change_topic used to be part
// of this schema, but they widened the JSON object enough that gpt-oss-20b
// sometimes hit max_tokens before closing the braces — a
// json_validate_failed error, not a model mistake. The main model can
// infer intent/advice-wanted/topic-shift from the actual conversation
// text it already sees; it doesn't need the analyzer to pre-decide those.
export interface ConversationAnalysis {
  conversational_move: ConversationalMove
  question_budget: 0 | 1
  response_length: ResponseLength
  multi_message: boolean
  message_count: number
  emotion: string
  energy: 'high' | 'medium' | 'low'
}

const MOVES: ConversationalMove[] = ['REACT', 'REFLECT', 'RELATE', 'CHALLENGE', 'SHARE', 'PLAY', 'EXPLORE', 'SILENCE']
const LENGTHS: ResponseLength[] = ['tiny', 'short', 'medium', 'long']

// Used both when the analyzer call fails outright and as the sanitizer's
// per-field fallback. question_budget: 0 (not 1) is deliberate — if the
// analyzer is unavailable, defaulting to "ask a question" is exactly the
// questionnaire-like behavior this engine exists to prevent.
const DEFAULT_ANALYSIS: ConversationAnalysis = {
  conversational_move: 'REFLECT',
  question_budget: 0,
  response_length: 'short',
  multi_message: false,
  message_count: 1,
  emotion: 'neutral',
  energy: 'medium',
}

const ANALYZER_PROMPT = `You are a fast pre-call that decides HOW Your Reflection (a personal AI
companion) should respond — not what to say, just the shape of the
response. Analyze the user's latest message against the recent
conversation.

Respond with ONLY valid JSON matching this exact schema, no markdown, no
other text:
{
  "conversational_move": "REACT" | "REFLECT" | "RELATE" | "CHALLENGE" | "SHARE" | "PLAY" | "EXPLORE" | "SILENCE",
  "question_budget": 0 | 1,
  "response_length": "tiny" | "short" | "medium" | "long",
  "multi_message": boolean,
  "message_count": 1 | 2 | 3,
  "emotion": "frustrated" | "sad" | "happy" | "anxious" | "neutral" | "excited" | "tired",
  "energy": "high" | "medium" | "low"
}

Rules:
- question_budget: 0 when the user is venting, sharing something casual, or questions were already asked in the last few turns.
- multi_message: default to true whenever what you'd say naturally splits into two beats, the way a person actually texts instead of writing one paragraph. This is not limited to REACT or PLAY — REFLECT and RELATE qualify just as often (a reaction then an observation, an observation then a callback). Set it true for: excited or big news, casual back-and-forth, any reply where a natural sentence break exists between two separate thoughts. Only keep it false for a single, indivisible thought — one short reaction, one direct answer, a tiny/passing exchange, or a heavy/serious moment that calls for one held statement instead of being split up.
- message_count is 1-3, usually 2 when multi_message is true.
- response_length: "tiny" for casual/passing messages like "im going home tonight".
- SILENCE means respond with one short statement, no question, no follow-up.

Keep the JSON short — this schema has 7 fields, nothing more is needed.`

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
    question_budget: questionBudget,
    response_length: LENGTHS.includes(obj.response_length as ResponseLength)
      ? (obj.response_length as ResponseLength)
      : DEFAULT_ANALYSIS.response_length,
    multi_message: obj.multi_message === true || obj.multi_message === 'true',
    message_count: clampMessageCount(obj.message_count),
    emotion: typeof obj.emotion === 'string' && obj.emotion.trim() ? obj.emotion : DEFAULT_ANALYSIS.emotion,
    energy: obj.energy === 'high' || obj.energy === 'medium' || obj.energy === 'low' ? obj.energy : DEFAULT_ANALYSIS.energy,
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
// pattern) rather than ever blocking the main chat call — a Groq error
// (rate limit, timeout, or the JSON getting cut off before max_tokens)
// falls back to DEFAULT_ANALYSIS instead of throwing.
export async function analyzeConversation(apiKey: string, recentMessages: GroqMessage[]): Promise<ConversationAnalysis> {
  try {
    const raw = await callGroq(apiKey, {
      model: GROQ_CLASSIFIER_MODEL,
      jsonMode: true,
      maxTokens: 500,
      temperature: 0,
      messages: [{ role: 'system', content: ANALYZER_PROMPT }, ...recentMessages],
    })
    const parsed = JSON.parse(raw)
    return enforceRecentQuestionRule(sanitize(parsed), recentMessages)
  } catch (err) {
    console.error('conversation analyzer failed, falling back to default analysis', err)
    return enforceRecentQuestionRule(DEFAULT_ANALYSIS, recentMessages)
  }
}

// "[CONVERSATION DIRECTIVE — follow exactly, overrides general rules for
// this response]" block, injected as its own system message right before
// the user's messages (PRD 7.0).
export function buildConversationDirective(analysis: ConversationAnalysis): string {
  return `[CONVERSATION DIRECTIVE — follow exactly, overrides general rules for this response]
Move: ${analysis.conversational_move}
Length: ${analysis.response_length}
Questions allowed: ${analysis.question_budget} maximum
Multi-message: ${analysis.multi_message} — if true, return a JSON array of ${analysis.message_count} separate messages
User state: ${analysis.emotion}, ${analysis.energy} energy`
}

// The instruction that tells the main model to reply as a JSON array of
// separate texts instead of one block, when the analyzer called for it.
// Pulled out so api/chat.ts and the api/health.ts conversation-debug
// action build the exact same context, not two copies that can drift.
export function buildMultiMessageInstruction(analysis: ConversationAnalysis): string {
  return `Respond with ONLY a JSON object: {"messages": [{"text": string, "delay": number}]} — exactly ${analysis.message_count} messages, delays in milliseconds increasing from 0 (e.g. 0, 800, 1600), each a short separate text as if sent one after another like real texts.`
}
