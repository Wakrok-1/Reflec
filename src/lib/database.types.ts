// Hand-written types mirroring supabase/migrations/0001_init.sql and
// 0002_v1_3_memory_upgrade.sql. Once a live Supabase project exists,
// regenerate with:
//   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

// Widened in Sprint 5 (0006_sprint5_integrations.sql) from the Sprint 0
// shape ({ enabled, frequency }), which nothing had consumed yet. Every
// reader treats a missing key as "off"/unset rather than throwing, so a
// profile row still carrying the old shape (never re-saved since) is
// handled the same as one with every key present.
export type NotificationPrefs = {
  enabled?: boolean
  frequency?: 'daily' | 'weekly' | 'off'
  daily_checkin?: boolean
  goal_reminders?: boolean
  suggestions?: boolean
  quiet_hours_start?: string | null
  quiet_hours_end?: string | null
}

export type PushSubscriptionJson = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export type Profile = {
  id: string
  name: string | null
  age: number | null
  class: string | null
  strengths: unknown[]
  philosophy: string | null
  core_values: unknown[]
  patterns: unknown[]
  summary_memory: string
  onboarding_completed_at: string | null
  personality_emergence_unlocked: boolean
  notification_prefs: NotificationPrefs
  push_subscription: PushSubscriptionJson | null
  created_at: string
  updated_at: string
}

export type JournalEntry = {
  id: string
  user_id: string
  mode: 'full' | 'snap'
  title: string | null
  content: string
  ai_reflection: string | null
  mood_tags: unknown[]
  energy_level: number | null
  themes: unknown[]
  linked_goal_ids: string[]
  source: 'chat' | 'manual' | 'apple_journal_import'
  entry_date: string
  embedding: number[] | null
  created_at: string
  updated_at: string
}

export type Snap = {
  id: string
  user_id: string
  content: string
  mood_tags: unknown[]
  energy_level: number | null
  themes: unknown[]
  linked_goal_id: string | null
  embedding: number[] | null
  created_at: string
}

export type TasteCategory = 'music' | 'books' | 'sport' | 'food' | 'aesthetics' | 'hobbies' | 'symbols'

export type TasteProfileItem = {
  id: string
  user_id: string
  category: TasteCategory
  item: string
  context: string | null
  source: 'onboarding' | 'chat' | 'manual'
  created_at: string
  updated_at: string
}

export type PatternExtraction = {
  user_id: string
  emotional_triggers: string[]
  coping_patterns: string[]
  energy_patterns: string[]
  communication_style: string | null
  recurring_themes: string[]
  taste_context: Record<string, { item: string; context: string | null }[]>
  writing_signature: Record<string, unknown>
  response_preference: Record<string, unknown>
  updated_at: string
}

export type DismissedSuggestionType = 'profile_field' | 'taste_entry' | 'growth_insight'

export type DismissedSuggestion = {
  id: string
  user_id: string
  suggestion_type: DismissedSuggestionType
  fingerprint: string
  payload: Record<string, unknown>
  created_at: string
}

export type ResponseSignal = {
  id: string
  user_id: string
  chat_message_id: string | null
  felt_right: boolean
  created_at: string
}

export type MemoryType =
  | 'EVENT'
  | 'BELIEF'
  | 'GOAL'
  | 'PREFERENCE'
  | 'EMOTION'
  | 'HABIT'
  | 'ACHIEVEMENT'
  | 'PROBLEM'

export type Memory = {
  id: string
  user_id: string
  type: MemoryType
  content: string
  confidence: number
  created_at: string
  last_seen_at: string
  related_entries: string[]
  embedding: number[] | null
}

export type PrivateEntryType = 'journal' | 'snap'

export type PrivateEntry = {
  id: string
  user_id: string
  entry_id: string
  entry_type: PrivateEntryType
  created_at: string
}

export type Goal = {
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

export type Suggestion = {
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

export type CalendarEvent = {
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

export type StravaData = {
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

export type ChatMessage = {
  id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  metadata: Record<string, unknown>
  embedding: number[] | null
  created_at: string
}

export type MemorySummary = {
  id: string
  user_id: string
  period_start: string
  period_end: string
  summary: string
  tier: 'onboarding' | 'daily' | 'weekly' | 'monthly'
  embedding: number[] | null
  created_at: string
}

export type GoogleCalendarConnection = {
  user_id: string
  access_token: string
  refresh_token: string
  token_expires_at: string
  scope: string | null
  calendar_id: string
  connected_at: string
  updated_at: string
}

export type OAuthState = {
  state: string
  user_id: string
  provider: 'google'
  created_at: string
}

export type NotificationType = 'daily_checkin' | 'goal_reminder' | 'suggestion_ready'

export type NotificationLogEntry = {
  id: string
  user_id: string
  type: NotificationType
  ref_id: string | null
  sent_at: string
}

// Conversation Engine v1.6: api/chat.ts generates one main-model response
// per turn and runs it through a string-based therapy-speak filter. This
// table logs the outcome as a lightweight preference signal for a future
// fine-tuning dataset — write-only from the app's perspective, never read
// back into a live response.
export type ResponseQualityLog = {
  id: string
  user_id: string
  response_text: string
  therapy_speak_score: number
  regenerated: boolean
  created_at: string
}

// supabase-js's generic client requires each table to carry a
// `Relationships` array and the schema to declare `Views`/`Functions`
// (see @supabase/postgrest-js's GenericTable/GenericSchema) — otherwise
// it silently falls back to `never` for every row type.
type Table<Row, Insert, Update = Partial<Row>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export type Database = {
  public: {
    Tables: {
      profiles: Table<Profile, Partial<Profile> & { id: string }>
      journal_entries: Table<JournalEntry, Partial<JournalEntry> & { user_id: string; content: string }>
      snaps: Table<Snap, Partial<Snap> & { user_id: string; content: string }>
      goals: Table<Goal, Partial<Goal> & { user_id: string; type: Goal['type']; title: string }>
      suggestions: Table<
        Suggestion,
        Partial<Suggestion> & { user_id: string; category: Suggestion['category']; title: string }
      >
      calendar_events: Table<
        CalendarEvent,
        Partial<CalendarEvent> & { user_id: string; title: string; start_time: string }
      >
      strava_data: Table<StravaData, Partial<StravaData> & { user_id: string; strava_activity_id: number }>
      chat_history: Table<
        ChatMessage,
        Partial<ChatMessage> & { user_id: string; role: ChatMessage['role']; content: string }
      >
      memory_summaries: Table<
        MemorySummary,
        Partial<MemorySummary> & {
          user_id: string
          period_start: string
          period_end: string
          summary: string
        }
      >
      taste_profile: Table<
        TasteProfileItem,
        Partial<TasteProfileItem> & { user_id: string; category: TasteCategory; item: string }
      >
      pattern_extractions: Table<PatternExtraction, Partial<PatternExtraction> & { user_id: string }>
      dismissed_suggestions: Table<
        DismissedSuggestion,
        Partial<DismissedSuggestion> & {
          user_id: string
          suggestion_type: DismissedSuggestionType
          fingerprint: string
        }
      >
      response_signals: Table<ResponseSignal, Partial<ResponseSignal> & { user_id: string }>
      memories: Table<Memory, Partial<Memory> & { user_id: string; type: MemoryType; content: string }>
      private_entries: Table<
        PrivateEntry,
        Partial<PrivateEntry> & { user_id: string; entry_id: string; entry_type: PrivateEntryType }
      >
      google_calendar_connections: Table<
        GoogleCalendarConnection,
        Partial<GoogleCalendarConnection> & {
          user_id: string
          access_token: string
          refresh_token: string
          token_expires_at: string
        }
      >
      oauth_states: Table<OAuthState, Partial<OAuthState> & { state: string; user_id: string; provider: 'google' }>
      notification_log: Table<
        NotificationLogEntry,
        Partial<NotificationLogEntry> & { user_id: string; type: NotificationType }
      >
      response_quality_log: Table<
        ResponseQualityLog,
        Partial<ResponseQualityLog> & { user_id: string; response_text: string }
      >
    }
    Views: Record<string, never>
    Functions: {
      match_journal_entries: {
        Args: { query_embedding: number[]; match_user_id: string; match_count?: number }
        Returns: { id: string; content: string; created_at: string; similarity: number }[]
      }
      match_chat_history: {
        Args: { query_embedding: number[]; match_user_id: string; match_count?: number }
        Returns: { id: string; content: string; created_at: string; similarity: number }[]
      }
    }
  }
}
