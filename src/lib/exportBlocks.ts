// Data model for the PDF Export Builder (PRD "Sprint 3 — Full Journal +
// PDF Export"). One Block[] array drives both the in-browser block editor
// and the react-pdf renderer, so "PDF content mirrors the canvas layout
// exactly" falls out of using the same data for both.

export type PageSize = 'A4' | 'A5'
export type PageColorKey = 'cream' | 'linen' | 'sage' | 'dove' | 'dark'
export type ExportStyle = 'minimal' | 'editorial'

export const PAGE_COLORS: Record<PageColorKey, string> = {
  cream: '#FAF8F5',
  linen: '#EDE8E1',
  sage: '#B5C9C1',
  dove: '#D4C8B8',
  dark: '#2C2C2A',
}

// mm, matching the spec's stated print dimensions.
export const PAGE_DIMENSIONS: Record<PageSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
}

export interface CanvasConfig {
  pageSize: PageSize
  pageColor: PageColorKey
  style: ExportStyle
  startDate: string
  endDate: string
}

export type BlockType =
  | 'quote'
  | 'journal_entry'
  | 'snap_collection'
  | 'goal_of_day'
  | 'journal_prompt'
  | 'photo'
  | 'mood_indicator'
  | 'divider'

interface BaseBlock {
  id: string
  /** yyyy-mm-dd this block belongs to — drives day grouping in timeline layouts. */
  day: string
}

export interface QuoteBlock extends BaseBlock {
  type: 'quote'
  text: string
}
export interface JournalEntryBlock extends BaseBlock {
  type: 'journal_entry'
  title: string | null
  text: string
}
export interface SnapCollectionBlock extends BaseBlock {
  type: 'snap_collection'
  snaps: string[]
}
export interface GoalOfDayBlock extends BaseBlock {
  type: 'goal_of_day'
  title: string
  progress: number
}
export interface JournalPromptBlock extends BaseBlock {
  type: 'journal_prompt'
  prompt: string
}
export interface PhotoBlock extends BaseBlock {
  type: 'photo'
  src: string
  width: number
  height: number
}
export interface MoodIndicatorBlock extends BaseBlock {
  type: 'mood_indicator'
  mood: string
  label: string
}
export interface DividerBlock extends BaseBlock {
  type: 'divider'
}

export type Block =
  | QuoteBlock
  | JournalEntryBlock
  | SnapCollectionBlock
  | GoalOfDayBlock
  | JournalPromptBlock
  | PhotoBlock
  | MoodIndicatorBlock
  | DividerBlock

export const BLOCK_LIBRARY: { type: BlockType; label: string }[] = [
  { type: 'quote', label: 'Quote of the day' },
  { type: 'journal_entry', label: 'Journal entry' },
  { type: 'snap_collection', label: 'Snap collection' },
  { type: 'goal_of_day', label: 'Goal of the day' },
  { type: 'journal_prompt', label: 'Journal prompt' },
  { type: 'photo', label: 'Photo' },
  { type: 'mood_indicator', label: 'Mood indicator' },
  { type: 'divider', label: 'Divider' },
]

const MOOD_OPTIONS = [
  { mood: '🙂', label: 'Good' },
  { mood: '😐', label: 'Neutral' },
  { mood: '😔', label: 'Low' },
  { mood: '🔥', label: 'Fired up' },
  { mood: '😴', label: 'Tired' },
]

export function nextMood(current: string) {
  const idx = MOOD_OPTIONS.findIndex((m) => m.mood === current)
  return MOOD_OPTIONS[(idx + 1) % MOOD_OPTIONS.length]
}

let counter = 0
function blockId() {
  counter += 1
  return `block-${Date.now()}-${counter}`
}

export function createBlock(type: BlockType, day: string): Block {
  switch (type) {
    case 'quote':
      return { id: blockId(), type, day, text: '' }
    case 'journal_entry':
      return { id: blockId(), type, day, title: null, text: '' }
    case 'snap_collection':
      return { id: blockId(), type, day, snaps: [] }
    case 'goal_of_day':
      return { id: blockId(), type, day, title: '', progress: 0 }
    case 'journal_prompt':
      return { id: blockId(), type, day, prompt: '' }
    case 'photo':
      return { id: blockId(), type, day, src: '', width: 160, height: 120 }
    case 'mood_indicator':
      return { id: blockId(), type, day, mood: MOOD_OPTIONS[1].mood, label: MOOD_OPTIONS[1].label }
    case 'divider':
      return { id: blockId(), type, day }
  }
}

export function listDaysInRange(startDate: string, endDate: string): string[] {
  const days: string[] = []
  const cursor = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}
