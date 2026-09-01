import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { createEvent, getValidAccessToken, listUpcomingEvents } from './_lib/googleCalendar'

type CalendarAction = 'read' | 'write'

interface CalendarRequestBody {
  action?: CalendarAction
  title?: string
  datetime?: string
  duration?: number
}

function formatConfirmation(title: string, datetime: string): string {
  const date = new Date(datetime)
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return `Added to your calendar — ${title} on ${dateStr} at ${timeStr}.`
}

// Fetches the next 7 days of the user's Google Calendar so the AI can
// reference upcoming events naturally in chat. Returns connected: false
// (not an error) when there's nothing to fetch.
async function handleRead(req: VercelRequest, res: VercelResponse) {
  const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const user = await verifyUser(req.headers.authorization)
  if (!user || !accessToken) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabase = createUserScopedClient(accessToken)
  const connection = await getValidAccessToken(supabase, user.id)
  if (!connection) {
    res.status(200).json({ connected: false, events: [] })
    return
  }

  const events = await listUpcomingEvents(connection.accessToken, connection.calendarId)
  res.status(200).json({ connected: true, events })
}

// Writes a Google Calendar event. Chat only calls this after the intent
// classifier detects a time/event mention AND the user explicitly
// confirms (GUARDRAIL 4: never write to Google Calendar without that
// confirmation) — this endpoint itself has no notion of "confirmed", it
// trusts the caller already got that from the user.
async function handleWrite(req: VercelRequest, res: VercelResponse, body: CalendarRequestBody) {
  const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const user = await verifyUser(req.headers.authorization)
  if (!user || !accessToken) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!body.title?.trim() || !body.datetime) {
    res.status(400).json({ error: '"title" and "datetime" are required' })
    return
  }
  const datetime = new Date(body.datetime)
  if (Number.isNaN(datetime.getTime())) {
    res.status(400).json({ error: '"datetime" must be a valid ISO 8601 timestamp' })
    return
  }

  const supabase = createUserScopedClient(accessToken)
  const connection = await getValidAccessToken(supabase, user.id)
  if (!connection) {
    res.status(400).json({ error: 'Google Calendar is not connected' })
    return
  }

  const title = body.title.trim()
  const event = await createEvent(connection.accessToken, connection.calendarId, {
    title,
    datetime: datetime.toISOString(),
    duration: body.duration,
  })

  await supabase.from('calendar_events').insert({
    user_id: user.id,
    google_event_id: event.id,
    title,
    start_time: datetime.toISOString(),
    end_time: new Date(datetime.getTime() + (body.duration ?? 60) * 60 * 1000).toISOString(),
    source: 'chat',
  })

  res.status(200).json({ eventId: event.id, confirmation: formatConfirmation(title, datetime.toISOString()) })
}

// Consolidated Google Calendar endpoint (Vercel Hobby plan's 12-function
// cap, see README): read and write share this file, routed by a body
// `action` field.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as CalendarRequestBody

  try {
    if (body.action === 'write') {
      await handleWrite(req, res, body)
      return
    }
    if (body.action === 'read') {
      await handleRead(req, res)
      return
    }
    res.status(400).json({ error: 'Unknown or missing "action"' })
  } catch (err) {
    console.error(`calendar (action=${body.action}) failed`, err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
