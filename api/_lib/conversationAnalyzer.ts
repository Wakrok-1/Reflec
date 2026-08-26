import { callGroq, GROQ_CLASSIFIER_MODEL, type GroqMessage } from './groq'

// The Conversation Engine's analyzer pre-call (PRD 7.0): a fast gpt-oss-20b
// pass that decides HOW Your Reflection should respond — not what to say,
// just the shape of the response — before the main gpt-oss-120b call.

export type ConversationalMove = 'REACT' | 'REFLECT' | 'RELATE' | 'CHALLENGE' | 'SHARE' | 'PLAY' | 'EXPLORE' | 'SILENCE'
export type ResponseLength = 'tiny' | 'short' | 'medium' | 'long'

export interface ConversationAnalysis {
  user_intent: string
  emotion: string
  energy: 'high' | 'medium' | 'low'
  advice_wanted: boolean
  question_budget: 0 | 1
  conversational_move: ConversationalMove
  response_length: ResponseLength
  multi_message: boolean
  message_count: number
  can_reference_past: boolean
  can_change_topic: boolean
}

const MOVES: ConversationalMove[] = ['REACT', 'REFLECT', 'RELATE', 'CHALLENGE', 'SHARE', 'PLAY', 'EXPLORE', 'SILENCE']
const LENGTHS: ResponseLength[] = ['tiny', 'short', 'medium', 'long']

const DEFAULT_ANALYSIS: ConversationAnalysis = {
  user_intent: 'sharing',
  emotion: 'neutral',
  energy: 'medium',
  advice_wanted: false,
  question_budget: 1,
  conversational_move: 'REFLECT',
  response_length: 'short',
  multi_message: false,
  message_count: 1,
  can_reference_past: true,
  can_change_topic: true,
}

const ANALYZER_PROMPT = `You are a fast pre-call that decides HOW Your Reflection (a personal AI
companion) should respond — not what to say, just the shape of the
response. Analyze the user's latest message against the recent
conversation.

Respond with ONLY a JSON object matching this exact schema, no other text:
{
  "user_intent": "venting" | "sharing" | "asking" | "casual" | "reflecting" | "excited" | "processing",
  "emotion": "frustrated" | "sad" | "happy" | "anxious" | "neutral" | "excited" | "tired",
  "energy": "high" | "medium" | "low",
  "advice_wanted": boolean,
  "question_budget": 0 | 1,
  "conversational_move": "REACT" | "REFLECT" | "RELATE" | "CHALLENGE" | "SHARE" | "PLAY" | "EXPLORE" | "SILENCE",
  "response_length": "tiny" | "short" | "medium" | "long",
  "multi_message": boolean,
  "message_count": 1 | 2 | 3,
  "can_reference_past": boolean,
  "can_change_topic": boolean
}

Rules:
- question_budget: 0 when the user is venting, sharing something casual, or questions were already asked in the last few turns.
- multi_message: true when the move is REACT or PLAY and energy is high, or when a natural break exists in what to say.
- message_count is 1-3, usually 1-2.
- response_length: "tiny" for casual/passing messages like "im going home tonight".
- SILENCE means respond with one short statement, no question, no follow-up.`

function clampMessageCount(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1
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
    user_intent: typeof obj.user_intent === 'string' && obj.user_intent.trim() ? obj.user_intent : DEFAULT_ANALYSIS.user_intent,
    emotion: typeof obj.emotion === 'string' && obj.emotion.trim() ? obj.emotion : DEFAULT_ANALYSIS.emotion,
    energy: obj.energy === 'high' || obj.energy === 'medium' || obj.energy === 'low' ? obj.energy : DEFAULT_ANALYSIS.energy,
    advice_wanted: obj.advice_wanted === true,
    question_budget: questionBudget,
    conversational_move: move,
    response_length: LENGTHS.includes(obj.response_length as ResponseLength)
      ? (obj.response_length as ResponseLength)
      : DEFAULT_ANALYSIS.response_length,
    multi_message: obj.multi_message === true,
    message_count: clampMessageCount(obj.message_count),
    can_reference_past: obj.can_reference_past !== false,
    can_change_topic: obj.can_change_topic !== false,
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
export async function analyzeConversation(apiKey: string, recentMessages: GroqMessage[]): Promise<ConversationAnalysis> {
  try {
    const raw = await callGroq(apiKey, {
      model: GROQ_CLASSIFIER_MODEL,
      jsonMode: true,
      maxTokens: 250,
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
Past reference: ${analysis.can_reference_past}
Topic shift allowed: ${analysis.can_change_topic}
User state: ${analysis.emotion}, ${analysis.energy} energy, advice wanted: ${analysis.advice_wanted}`
}
