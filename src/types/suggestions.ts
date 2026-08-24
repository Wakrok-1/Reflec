import type { TasteCategory } from '../lib/database.types'

export type ProfileFieldName = 'name' | 'age' | 'class' | 'strengths' | 'philosophy' | 'core_values'

export interface ProfileFieldSuggestion {
  type: 'profile_field'
  id: string
  field: ProfileFieldName
  label: string
  value: string | number | string[]
}

export interface TasteEntrySuggestion {
  type: 'taste_entry'
  id: string
  category: TasteCategory
  item: string
  context: string | null
}

export type Suggestion = ProfileFieldSuggestion | TasteEntrySuggestion
