import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { getValidAccessToken, listUpcomingEvents } from './_lib/googleCalendar'

// Fetches the next 7 days of the user's Google Calendar so the AI can
// reference upcoming events naturally in chat. Returns connected: false
// (not an error) when there's nothing to fetch.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
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
  } catch (err) {
    console.error('calendar-read failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
