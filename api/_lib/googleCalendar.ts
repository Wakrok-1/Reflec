import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types'

// Google Calendar OAuth + API wrapper (PRD 6.2). Read/write scopes only —
// never used to read anything beyond calendar events.
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
export const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

export function buildGoogleAuthUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured on the server')
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth env vars are not configured on the server')

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope: string
  }
}

async function refreshAccessToken(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth env vars are not configured on the server')

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    throw new Error(`Google token refresh failed (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as { access_token: string; expires_in: number }
}

// Returns a live access token for this user's connection, transparently
// refreshing and persisting a new one if the stored token has expired —
// "token refresh handled automatically" per the spec. `supabase` must be
// scoped so it can read/update this specific connection row: either the
// caller's own user-scoped client, or the admin client from the cron job
// (which has already resolved the target user_id through its own means).
export async function getValidAccessToken(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<{ accessToken: string; calendarId: string } | null> {
  const { data: connection } = await supabase
    .from('google_calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (!connection) return null

  const expiresInMs = new Date(connection.token_expires_at).getTime() - Date.now()
  if (expiresInMs > 60_000) {
    return { accessToken: connection.access_token, calendarId: connection.calendar_id }
  }

  const refreshed = await refreshAccessToken(connection.refresh_token)
  const tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  await supabase
    .from('google_calendar_connections')
    .update({ access_token: refreshed.access_token, token_expires_at: tokenExpiresAt })
    .eq('user_id', userId)
  return { accessToken: refreshed.access_token, calendarId: connection.calendar_id }
}

export interface UpcomingEvent {
  title: string
  date: string // yyyy-mm-dd
  time: string | null // e.g. "10:00 am" — null for all-day events
}

export async function listUpcomingEvents(accessToken: string, calendarId: string): Promise<UpcomingEvent[]> {
  const now = new Date()
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: in7Days.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  })
  const response = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) {
    throw new Error(`Google Calendar list failed (${response.status}): ${await response.text()}`)
  }
  const data = (await response.json()) as {
    items?: { summary?: string; start?: { date?: string; dateTime?: string } }[]
  }
  return (data.items ?? []).map((item) => {
    const dateTime = item.start?.dateTime
    const dateOnly = item.start?.date
    const date = (dateTime ?? dateOnly ?? '').slice(0, 10)
    const time = dateTime
      ? new Date(dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
      : null
    return { title: item.summary ?? '(untitled event)', date, time }
  })
}

export interface CreateEventInput {
  title: string
  datetime: string // ISO 8601
  duration?: number // minutes, default 60
}

export async function createEvent(
  accessToken: string,
  calendarId: string,
  input: CreateEventInput,
): Promise<{ id: string; htmlLink: string }> {
  const start = new Date(input.datetime)
  const end = new Date(start.getTime() + (input.duration ?? 60) * 60 * 1000)

  const response = await fetch(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: input.title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    }),
  })
  if (!response.ok) {
    throw new Error(`Google Calendar create event failed (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as { id: string; htmlLink: string }
}
