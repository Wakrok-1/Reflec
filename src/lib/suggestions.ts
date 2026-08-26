import { supabase } from './supabase'
import type { DismissedSuggestionType } from './database.types'
import type { Suggestion } from '../types/suggestions'

// A stable dedup key for a suggestion's content, independent of any
// per-render id. Used both to write dismissed_suggestions and to filter
// suggestions that were already dismissed before, so they never resurface
// (PRD 5.2: "Dismissed suggestions are not re-surfaced").
export function fingerprintSuggestion(s: Suggestion): string {
  switch (s.type) {
    case 'profile_field': {
      const value = Array.isArray(s.value) ? s.value.join('|') : String(s.value)
      return `${s.field}:${value}`.toLowerCase().trim()
    }
    case 'taste_entry':
      return `${s.category}:${s.item}`.toLowerCase().trim()
    case 'goal_suggestion':
      return `goal:${s.title}`.toLowerCase().trim()
    case 'bucket_list_suggestion':
      return `bucket:${s.item}`.toLowerCase().trim()
  }
}

// goal/bucket-list nudges fall under the schema's general "growth-page
// nudge" bucket (see dismissed_suggestions' check constraint) — no new
// suggestion_type value needed for them.
function suggestionTypeFor(s: Suggestion): DismissedSuggestionType {
  if (s.type === 'profile_field') return 'profile_field'
  if (s.type === 'taste_entry') return 'taste_entry'
  return 'growth_insight'
}

export async function fetchDismissedFingerprints(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('dismissed_suggestions')
    .select('suggestion_type, fingerprint')
    .eq('user_id', userId)

  if (error || !data) return new Set()
  return new Set(data.map((row) => `${row.suggestion_type}:${row.fingerprint}`))
}

export function isDismissed(s: Suggestion, dismissed: Set<string>): boolean {
  return dismissed.has(`${suggestionTypeFor(s)}:${fingerprintSuggestion(s)}`)
}

export async function dismissSuggestion(userId: string, s: Suggestion) {
  await supabase.from('dismissed_suggestions').upsert(
    {
      user_id: userId,
      suggestion_type: suggestionTypeFor(s),
      fingerprint: fingerprintSuggestion(s),
      payload: s as unknown as Record<string, unknown>,
    },
    { onConflict: 'user_id,suggestion_type,fingerprint' },
  )
}
