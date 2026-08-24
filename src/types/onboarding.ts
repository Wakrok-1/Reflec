import type { TasteCategory } from '../lib/database.types'

export interface ExtractedProfile {
  name: string | null
  age: number | null
  class: string | null
  strengths: string[]
  philosophy: string | null
  core_values: string[]
}

export interface ExtractedTasteItem {
  category: TasteCategory
  item: string
  context: string | null
}

export interface OnboardingExtraction {
  profile: ExtractedProfile
  taste: ExtractedTasteItem[]
  summary: string
}
