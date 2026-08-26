import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { sendPush } from './_lib/webpush'

interface SendNotificationBody {
  title?: string
  body?: string
}

// Self-service "send me a notification" — used by the Notifications
// settings UI to confirm push actually works after subscribing. Always
// sends to the CALLER's own stored subscription, never to an arbitrary
// userId a client might pass in: the daily cron (api/cron/daily-checkin.ts)
// is the only place that sends notifications to *other* users, and it
// sends directly via sendPush rather than through this HTTP endpoint, so
// this one never needs to trust a client-supplied target user.
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

    const body = req.body as SendNotificationBody
    const title = body.title?.trim() || 'Your Reflection'
    const message = body.body?.trim() || 'Notifications are working.'

    const supabase = createUserScopedClient(accessToken)
    const { data: profile } = await supabase
      .from('profiles')
      .select('push_subscription')
      .eq('id', user.id)
      .single()

    if (!profile?.push_subscription) {
      res.status(400).json({ error: 'No push subscription on file for this account' })
      return
    }

    const delivered = await sendPush(profile.push_subscription, { title, body: message })
    if (!delivered) {
      await supabase.from('profiles').update({ push_subscription: null }).eq('id', user.id)
      res.status(410).json({ error: 'Push subscription is no longer valid — please re-enable notifications' })
      return
    }

    res.status(200).json({ sent: true })
  } catch (err) {
    console.error('send-notification failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
