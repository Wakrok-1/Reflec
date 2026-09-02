import { SYSTEM_PROMPT } from './systemPrompt'
import type { Goal, PatternExtraction, Profile, MemorySummary, SelfConcept } from './database.types'

// Token budget (PRD 7.2 "Per-Request Context Injection"). Profile +
// patterns are the fixed "hot" tier and are never trimmed; summaries fill
// the next slice; vector hits fill whatever's left. Because we fill in
// that priority order and simply stop once each tier's ceiling is hit,
// "trim vector hits first, then older summaries" falls out naturally —
// vector hits are the last tier filled, so they're the first to come up
// short.
//
// This used to be a much tighter, per-section hard-capped budget (PRD
// v1.6 token-budget hardening) built to squeeze the whole request under
// Groq's 8,000 TPM free-tier ceiling. That effort was abandoned — the
// static system prompt alone is already ~2,880 tokens, so no amount of
// memory trimming got the total under the limit — in favor of moving the
// main model call to Gemini 1.5 Flash (api/_lib/gemini.ts), which has a
// 1M token context and no comparable TPM wall. These budgets are back to
// their original, more generous sizes.
const SUMMARY_CUMULATIVE_BUDGET = 1200 // 800 (hot) + 400 (summaries)
const TOTAL_BUDGET = 2000 // + 500-ish for vector hits, whatever remains

// No tokenizer dependency here — this is a soft relevance/cost budget,
// not a hard context-window limit, so a ~4-chars-per-token approximation
// is good enough.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
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
  /**
   * Self-Concept Layer (PRD v1.6 Part 2). `null` until the extract-patterns
   * Edge Function has run at least once for this user — the whole
   * <self_concept> block is then omitted entirely, same "no data yet"
   * treatment as calendar.
   */
  selfConcept: SelfConcept | null
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

// Self-Concept Layer rendering (PRD v1.6 Part 2). declared_self entries
// carry the highest authority (see systemPrompt.ts's SELF-CONCEPT
// PRIORITY) — they come from the user's own words, not inference.
// observed_self.patterns are behavioural inferences the extract-patterns
// Edge Function made, each with its own confidence — separate from the
// six broad confidence_scores dimensions, which describe how much
// evidence exists overall, not how sure we are about any one pattern.
function formatSelfConcept(selfConcept: SelfConcept | null): string {
  if (!selfConcept) return ''

  const declaredEntries = Object.entries(selfConcept.declared_self ?? {})
  const declaredLines = declaredEntries.map(
    ([key, entry]) => `    <${key} source="${escapeXmlAttr(entry.source)}">${escapeXmlAttr(entry.value)}</${key}>`,
  )

  const patterns = selfConcept.observed_self?.patterns ?? []
  const observedLines = patterns.map(
    (p) => `    <pattern confidence="${p.confidence.toFixed(2)}">${escapeXmlAttr(p.text)}</pattern>`,
  )

  const tensionLines = (selfConcept.identity_tensions ?? []).map(
    (t) => `    <tension>${escapeXmlAttr(t)}</tension>`,
  )

  const evolutionLines = (selfConcept.identity_evolution ?? []).map(
    (e) => `    <period date="${escapeXmlAttr(e.period)}">${escapeXmlAttr(e.description)}</period>`,
  )

  if (!declaredLines.length && !observedLines.length && !tensionLines.length && !evolutionLines.length) {
    return ''
  }

  const c = selfConcept.confidence_scores
  const confidenceLine = `    surface: ${c.surface.toFixed(2)}, values: ${c.values.toFixed(2)}, behaviour: ${c.behaviour.toFixed(2)}, emotional_patterns: ${c.emotional_patterns.toFixed(2)}, self_concept: ${c.self_concept.toFixed(2)}, deep_identity: ${c.deep_identity.toFixed(2)}`

  return `<self_concept>
  <declared>
${declaredLines.join('\n') || '    <none />'}
  </declared>
  <observed>
${observedLines.join('\n') || '    <none />'}
  </observed>
  <tensions>
${tensionLines.join('\n') || '    <none />'}
  </tensions>
  <evolution>
${evolutionLines.join('\n') || '    <none />'}
  </evolution>
  <confidence>
${confidenceLine}
  </confidence>
</self_concept>`
}

export interface BuiltContext {
  values: Record<string, string>
  tokensUsed: number
}

export function buildContextValues(bundle: MemoryBundle): BuiltContext {
  const { profile, patterns } = bundle

  const values: Record<string, string> = {
    name: profile.name || 'unknown',
    age: profile.age != null ? String(profile.age) : 'unknown',
    class: profile.class || 'not yet defined',
    strengths: joinOrFallback(profile.strengths as unknown[]),
    philosophy: profile.philosophy || 'not yet shared',
    core_values: joinOrFallback(profile.core_values as unknown[]),
    emotional_triggers: joinOrFallback(patterns?.emotional_triggers),
    coping_patterns: joinOrFallback(patterns?.coping_patterns),
    energy_patterns: joinOrFallback(patterns?.energy_patterns),
    communication_style: patterns?.communication_style || 'not yet established',
    recurring_themes: joinOrFallback(patterns?.recurring_themes),
    taste_context: formatTasteContext(patterns?.taste_context),
    writing_signature: formatRecord(patterns?.writing_signature, 'not yet established'),
    response_preference: formatRecord(patterns?.response_preference, 'not yet established'),
    rolling_summary_last_7_days: 'no recent summary yet',
    vector_search_hits: 'nothing relevant surfaced yet',
    active_goals: formatActiveGoals(bundle.activeGoals),
    calendar: formatCalendar(bundle.upcomingEvents),
    self_concept: formatSelfConcept(bundle.selfConcept),
  }

  // Hot tier (profile + patterns) is fixed and never trimmed, but still
  // counts against the budget so the lower tiers know how much room they
  // have left.
  let tokensUsed = estimateTokens(Object.values(values).join(' '))

  const summaryLines: string[] = []
  for (const summary of bundle.summaries) {
    const line = `[${summary.period_start.slice(0, 10)} to ${summary.period_end.slice(0, 10)}, ${summary.tier}] ${summary.summary}`
    const lineTokens = estimateTokens(line)
    if (tokensUsed + lineTokens > SUMMARY_CUMULATIVE_BUDGET) break
    summaryLines.push(line)
    tokensUsed += lineTokens
  }
  if (summaryLines.length > 0) {
    values.rolling_summary_last_7_days = summaryLines.join('\n')
  }

  const hitLines: string[] = []
  for (const hit of bundle.vectorHits) {
    const line = `(${hit.created_at.slice(0, 10)}) ${hit.content}`
    const lineTokens = estimateTokens(line)
    if (tokensUsed + lineTokens > TOTAL_BUDGET) break
    hitLines.push(line)
    tokensUsed += lineTokens
  }
  if (hitLines.length > 0) {
    values.vector_search_hits = hitLines.join('\n')
  }

  return { values, tokensUsed }
}

// Replaces every {placeholder} in SYSTEM_PROMPT's [MEMORY] block with the
// built context values. Everything outside [MEMORY] (IDENTITY, RULES,
// BEHAVIOUR, GUARDRAILS, ...) is untouched, verbatim prose.
export function renderSystemPrompt(bundle: MemoryBundle): { prompt: string; tokensUsed: number } {
  const { values, tokensUsed } = buildContextValues(bundle)
  const prompt = SYSTEM_PROMPT.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  )
  return { prompt, tokensUsed }
}
