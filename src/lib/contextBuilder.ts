import { SYSTEM_PROMPT } from './systemPrompt'
import type { PatternExtraction, Profile, MemorySummary } from './database.types'

// Token budget (PRD 7.2 "Per-Request Context Injection"). Profile +
// patterns are the fixed "hot" tier and are never trimmed; summaries fill
// the next slice; vector hits fill whatever's left. Because we fill in
// that priority order and simply stop once each tier's ceiling is hit,
// "trim vector hits first, then older summaries" falls out naturally —
// vector hits are the last tier filled, so they're the first to come up
// short.
const SUMMARY_CUMULATIVE_BUDGET = 1200 // 800 (hot) + 400 (summaries)
const TOTAL_BUDGET = 2000 // + 500-ish for vector hits, whatever remains

// No tokenizer dependency here — this is a soft relevance/cost budget,
// not a hard context-window limit (gpt-oss-120b has 131k context), so a
// ~4-chars-per-token approximation is good enough.
function estimateTokens(text: string): number {
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

export interface MemoryBundle {
  profile: Profile
  patterns: PatternExtraction | null
  /** Most-recent-first. */
  summaries: MemorySummary[]
  /** Sorted by similarity, most relevant first. */
  vectorHits: VectorHit[]
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
