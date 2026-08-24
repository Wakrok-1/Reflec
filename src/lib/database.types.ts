// Hand-written types mirroring supabase/migrations/0001_init.sql.
// Once a live Supabase project exists, regenerate with:
//   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

export interface Profile {
  id: string
  name: string | null
  age: number | null
  class: string | null
  strengths: unknown[]
  philosophy: string | null
  favourites: Record<string, unknown>
  core_values: unknown[]
  patterns: unknown[]
  summary_memory: string
  onboarding_completed_at: string | null
  notification_prefs: { enabled: boolean; frequency: 'daily' | 'weekly' | 'off' }
  created_at: string
  updated_at: string
}

export interface JournalEntry {
  id: string
  user_id: string
  mode: 'full' | 'snap'
  content: string
  ai_reflection: string | null
  mood_tags: unknown[]
  energy_level: number | null
  themes: unknown[]
  linked_goal_ids: string[]
  source: 'chat' | 'manual' | 'apple_journal_import'
  entry_date: string
  created_at: string
  updated_at: string
}

export interface Snap {
  id: string
  user_id: string
  content: string
  mood_tags: unknown[]
  energy_level: number | null
  themes: unknown[]
  linked_goal_id: string | null
  created_at: string
}

export interface Goal {
  id: string
  user_id: string
  type: 'big_goal' | 'increment' | 'bucket_list'
  parent_goal_id: string | null
  title: string
  description: string | null
  status: 'active' | 'completed' | 'archived'
  target_age: number | null
  target_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface Suggestion {
  id: string
  user_id: string
  category: 'book' | 'music' | 'habit' | 'experience' | 'food' | 'journal_prompt'
  title: string
  description: string | null
  status: 'pending' | 'done' | 'saved' | 'not_for_me'
  cycle_period: 'weekly' | 'monthly'
  created_at: string
  responded_at: string | null
}

export interface CalendarEvent {
  id: string
  user_id: string
  google_event_id: string | null
  title: string
  description: string | null
  start_time: string
  end_time: string | null
  source: 'chat' | 'manual' | 'google_sync'
  created_at: string
}

export interface StravaData {
  id: string
  user_id: string
  strava_activity_id: number
  activity_type: string | null
  distance_meters: number | null
  duration_seconds: number | null
  average_pace: number | null
  average_heart_rate: number | null
  started_at: string | null
  raw: Record<string, unknown>
  created_at: string
}

export interface ChatMessage {
  id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface MemorySummary {
  id: string
  user_id: string
  period_start: string
  period_end: string
  summary: string
  created_at: string
}

export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile> & { id: string }; Update: Partial<Profile> }
      journal_entries: {
        Row: JournalEntry
        Insert: Partial<JournalEntry> & { user_id: string; content: string }
        Update: Partial<JournalEntry>
      }
      snaps: {
        Row: Snap
        Insert: Partial<Snap> & { user_id: string; content: string }
        Update: Partial<Snap>
      }
      goals: {
        Row: Goal
        Insert: Partial<Goal> & { user_id: string; type: Goal['type']; title: string }
        Update: Partial<Goal>
      }
      suggestions: {
        Row: Suggestion
        Insert: Partial<Suggestion> & { user_id: string; category: Suggestion['category']; title: string }
        Update: Partial<Suggestion>
      }
      calendar_events: {
        Row: CalendarEvent
        Insert: Partial<CalendarEvent> & { user_id: string; title: string; start_time: string }
        Update: Partial<CalendarEvent>
      }
      strava_data: {
        Row: StravaData
        Insert: Partial<StravaData> & { user_id: string; strava_activity_id: number }
        Update: Partial<StravaData>
      }
      chat_history: {
        Row: ChatMessage
        Insert: Partial<ChatMessage> & { user_id: string; role: ChatMessage['role']; content: string }
        Update: Partial<ChatMessage>
      }
      memory_summaries: {
        Row: MemorySummary
        Insert: Partial<MemorySummary> & {
          user_id: string
          period_start: string
          period_end: string
          summary: string
        }
        Update: Partial<MemorySummary>
      }
    }
  }
}
