import { SYSTEM_PROMPT } from './systemPrompt'
import type { Goal, PatternExtraction, Profile, MemorySummary } from './database.types'

// Hard per-section token caps (PRD v1.6 token-budget hardening) — the
// main model call was hitting Groq's 8,000 TPM free-tier limit on the
// very first call, before any regeneration. 1,250 tokens total across
// every dynamic memory section, leaving headroom under the fixed system
// prompt prose (RULES/GUARDRAILS/etc., not capped here — see
// systemPrompt.ts) plus conversation history plus the response itself.
const PROFILE_TOKEN_CAP = 300
const PATTERNS_TOKEN_CAP = 200
const TASTE_TOKEN_CAP = 150
const SUMMARIES_TOKEN_CAP = 200
const VECTOR_HITS_TOKEN_CAP = 200
const GOALS_TOKEN_CAP = 100
const CALENDAR_TOKEN_CAP = 100

// No tokenizer dependency here — this is a soft relevance/cost budget,
// not a hard context-window limit (gpt-oss-120b has 131k context), so a
// ~4-chars-per-token approximation is good enough.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Truncates a single block of text to fit a token cap, character-based
// (the same ~4-chars-per-token estimate as everywhere else in this
// file), with a trailing ellipsis when it actually had to cut something.
function capText(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`
}

// Truncates a group of named fields (e.g. profile's name/age/class/...)
// down to a shared token budget by scaling every field's length by the
// same ratio, rather than a priority order that would zero some fields
// out entirely while leaving others untouched — every field in the group
// keeps some content, proportional to how much it had to begin with.
function capFieldGroup(fields: Record<string, string>, maxTokens: number): Record<string, string> {
  const maxChars = maxTokens * 4
  const totalChars = Object.values(fields).reduce((sum, value) => sum + value.length, 0)
  if (totalChars <= maxChars) return fields
  const ratio = maxChars / totalChars
  const capped: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    const allowed = Math.max(0, Math.floor(value.length * ratio) - 1)
    capped[key] = value.length > allowed ? `${value.slice(0, allowed).trim()}…` : value
  }
  return capped
}

function joinOrFallback(items: unknown[] | undefined | null, fallback = 'none yet'): string {
  if (!items || items.length === 0) return fallback
  return items.map(String).join(', ')
}

function formatTasteContext(taste: PatternExtraction['taste_context'] | undefined): string {
  if (!taste || Object.keys(taste).length === 0) return 'nothing learned yet'
  const lines: string[] = []
  for (const [category, entries] of Object.entries(taste)) {
    for (const entry of entries) {
      const context = entry.context ? ` context="${entry.context}"` : ''
      lines.push(`<${category} item="${entry.item}"${context} />`)
    }
  }
  return lines.length ? lines.join('\n  ') : 'nothing learned yet'
}

function formatRecord(record: Record<string, unknown> | undefined, fallback: string): string {
  if (!record || Object.keys(record).length === 0) return fallback
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('; ')
}

export interface VectorHit {
  content: string
  created_at: string
  source: 'journal_entries' | 'chat_history'
  similarity: number
}

export interface ActiveGoalSummary {
  title: string
  progress: number
  incrementsDone: number
  incrementsTotal: number
}

export interface UpcomingCalendarEvent {
  title: string
  date: string
  time: string | null
}

export interface MemoryBundle {
  profile: Profile
  patterns: PatternExtraction | null
  /** Most-recent-first. */
  summaries: MemorySummary[]
  /** Sorted by similarity, most relevant first. */
  vectorHits: VectorHit[]
  /** Active big_goal rows with their increment progress (PRD 5.5 / Sprint 4). */
  activeGoals: ActiveGoalSummary[]
  /**
   * Next 7 days of Google Calendar events (Sprint 5 / PRD 6.2).
   * `undefined` when the user hasn't connected Google Calendar — the
   * whole <calendar> block is then omitted entirely, no empty tag.
   */
  upcomingEvents: UpcomingCalendarEvent[] | undefined
}

// Reduces flat `goals` table rows (big_goal + increment, any status) down
// to the active big goals' progress — shared by api/chat.ts (context
// injection) and, indirectly, by the Goals page's own progress math.
export function buildActiveGoalsSummary(rows: Goal[]): ActiveGoalSummary[] {
  const incrementsByParent = new Map<string, Goal[]>()
  for (const row of rows) {
    if (row.type !== 'increment' || !row.parent_goal_id) continue
    const list = incrementsByParent.get(row.parent_goal_id) ?? []
    list.push(row)
    incrementsByParent.set(row.parent_goal_id, list)
  }

  return rows
    .filter((g) => g.type === 'big_goal' && g.status === 'active')
    .map((g) => {
      const increments = incrementsByParent.get(g.id) ?? []
      const incrementsDone = increments.filter((i) => i.status === 'completed').length
      const incrementsTotal = increments.length
      return {
        title: g.title,
        progress: incrementsTotal > 0 ? Math.round((incrementsDone / incrementsTotal) * 100) : 0,
        incrementsDone,
        incrementsTotal,
      }
    })
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatActiveGoals(goals: ActiveGoalSummary[] | undefined): string {
  if (!goals || goals.length === 0) return '<active_goals />'
  const lines = goals.map(
    (g) =>
      `  <goal title="${escapeXmlAttr(g.title)}" progress="${g.progress}%" increments_done="${g.incrementsDone}" increments_total="${g.incrementsTotal}" />`,
  )
  return `<active_goals>\n${lines.join('\n')}\n</active_goals>`
}

// Unlike active_goals (always shown, even empty), calendar is fully
// omitted — not even a self-closing tag — when Google Calendar isn't
// connected: the model shouldn't be told "no events" when the truth is
// "no calendar access at all."
function formatCalendar(events: UpcomingCalendarEvent[] | undefined): string {
  if (events === undefined) return ''
  if (events.length === 0) return '<calendar>\n  <upcoming />\n</calendar>'
  const lines = events.map(
    (e) =>
      `    <event title="${escapeXmlAttr(e.title)}" date="${e.date}"${e.time ? ` time="${escapeXmlAttr(e.time)}"` : ''} />`,
  )
  return `<calendar>\n  <upcoming>\n${lines.join('\n')}\n  </upcoming>\n</calendar>`
}

// Per-section token counts after capping — logged by api/chat.ts (TEMP
// DEBUG, context token budget investigation) to see which sections
// actually drive total prompt size in production.
export interface ContextTokenBreakdown {
  profile_tokens: number
  patterns_tokens: number
  taste_tokens: number
  summaries_tokens: number
  vector_hits_tokens: number
  goals_tokens: number
  calendar_tokens: number
}

export interface BuiltContext {
  values: Record<string, string>
  tokensUsed: number
  breakdown: ContextTokenBreakdown
}

export function buildContextValues(bundle: MemoryBundle): BuiltContext {
  const { profile, patterns } = bundle

  const profileFields = capFieldGroup(
    {
      name: profile.name || 'unknown',
      age: profile.age != null ? String(profile.age) : 'unknown',
      class: profile.class || 'not yet defined',
      strengths: joinOrFallback(profile.strengths as unknown[]),
      philosophy: profile.philosophy || 'not yet shared',
      core_values: joinOrFallback(profile.core_values as unknown[]),
    },
    PROFILE_TOKEN_CAP,
  )

  const patternsFields = capFieldGroup(
    {
      emotional_triggers: joinOrFallback(patterns?.emotional_triggers),
      coping_patterns: joinOrFallback(patterns?.coping_patterns),
      energy_patterns: joinOrFallback(patterns?.energy_patterns),
      communication_style: patterns?.communication_style || 'not yet established',
      recurring_themes: joinOrFallback(patterns?.recurring_themes),
      writing_signature: formatRecord(patterns?.writing_signature, 'not yet established'),
      response_preference: formatRecord(patterns?.response_preference, 'not yet established'),
    },
    PATTERNS_TOKEN_CAP,
  )

  const tasteContext = capText(formatTasteContext(patterns?.taste_context), TASTE_TOKEN_CAP)
  const activeGoalsText = capText(formatActiveGoals(bundle.activeGoals), GOALS_TOKEN_CAP)
  const calendarText = capText(formatCalendar(bundle.upcomingEvents), CALENDAR_TOKEN_CAP)

  const values: Record<string, string> = {
    ...profileFields,
    ...patternsFields,
    taste_context: tasteContext,
    rolling_summary_last_7_days: 'no recent summary yet',
    vector_search_hits: 'nothing relevant surfaced yet',
    active_goals: activeGoalsText,
    calendar: calendarText,
  }

  // Independent budgets, not cumulative with everything already filled —
  // each dynamic section gets its own fixed slice rather than "whatever
  // the hot tier left over," so one large profile can't crowd out
  // summaries/vector hits entirely.
  const summaryLines: string[] = []
  let summaryTokens = 0
  for (const summary of bundle.summaries) {
    const line = `[${summary.period_start.slice(0, 10)} to ${summary.period_end.slice(0, 10)}, ${summary.tier}] ${summary.summary}`
    const lineTokens = estimateTokens(line)
    if (summaryTokens + lineTokens > SUMMARIES_TOKEN_CAP) break
    summaryLines.push(line)
    summaryTokens += lineTokens
  }
  if (summaryLines.length > 0) {
    values.rolling_summary_last_7_days = summaryLines.join('\n')
  }

  const hitLines: string[] = []
  let vectorHitTokens = 0
  for (const hit of bundle.vectorHits) {
    const line = `(${hit.created_at.slice(0, 10)}) ${hit.content}`
    const lineTokens = estimateTokens(line)
    if (vectorHitTokens + lineTokens > VECTOR_HITS_TOKEN_CAP) break
    hitLines.push(line)
    vectorHitTokens += lineTokens
  }
  if (hitLines.length > 0) {
    values.vector_search_hits = hitLines.join('\n')
  }

  const breakdown: ContextTokenBreakdown = {
    profile_tokens: estimateTokens(Object.values(profileFields).join(' ')),
    patterns_tokens: estimateTokens(Object.values(patternsFields).join(' ')),
    taste_tokens: estimateTokens(tasteContext),
    summaries_tokens: estimateTokens(values.rolling_summary_last_7_days),
    vector_hits_tokens: estimateTokens(values.vector_search_hits),
    goals_tokens: estimateTokens(activeGoalsText),
    calendar_tokens: estimateTokens(calendarText),
  }

  const tokensUsed = Object.values(breakdown).reduce((sum, n) => sum + n, 0)

  return { values, tokensUsed, breakdown }
}

// Replaces every {placeholder} in SYSTEM_PROMPT's [MEMORY] block with the
// built context values. Everything outside [MEMORY] (IDENTITY, RULES,
// BEHAVIOUR, GUARDRAILS, ...) is untouched, verbatim prose.
export function renderSystemPrompt(bundle: MemoryBundle): { prompt: string; tokensUsed: number; breakdown: ContextTokenBreakdown } {
  const { values, tokensUsed, breakdown } = buildContextValues(bundle)
  const prompt = SYSTEM_PROMPT.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  )
  return { prompt, tokensUsed, breakdown }
}
