import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { createAdminClient } from './_lib/supabaseAdmin'
import { sendPush } from './_lib/webpush'

interface SendNotificationBody {
  userId?: string
  title?: string
  body?: string
}

function isTrustedServiceCaller(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  return !!cronSecret && req.headers.authorization === `Bearer ${cronSecret}`
}

// Two ways in:
//
// 1. Self-service — a normal user session (the Notifications settings
//    UI's "send me a test push"). Always sends to the CALLER's own
//    stored subscription; a client-supplied userId is never trusted.
// 2. Trusted service call — the Supabase daily-checkin Edge Function
//    (itself triggered by pg_cron, see
//    supabase/migrations/0007_pg_cron_daily_checkin.sql), authenticated
//    with CRON_SECRET rather than a user session, since it isn't one.
//    Only this path may name an arbitrary userId — it's the one place
//    in this app that sends a notification to someone other than the
//    caller, and only because the caller IS the app's own trusted cron
//    pipeline, not a user.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = req.body as SendNotificationBody
    const title = body.title?.trim() || 'Your Reflection'
    const message = body.body?.trim() || 'Notifications are working.'

    if (isTrustedServiceCaller(req)) {
      if (!body.userId) {
        res.status(400).json({ error: '"userId" is required' })
        return
      }
      const admin = createAdminClient()
      const { data: profile } = await admin
        .from('profiles')
        .select('push_subscription')
        .eq('id', body.userId)
        .single()

      if (!profile?.push_subscription) {
        res.status(400).json({ error: 'No push subscription on file for this account' })
        return
      }

      const delivered = await sendPush(profile.push_subscription, { title, body: message })
      if (!delivered) {
        await admin.from('profiles').update({ push_subscription: null }).eq('id', body.userId)
        res.status(410).json({ sent: false })
        return
      }
      res.status(200).json({ sent: true })
      return
    }

    const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const user = await verifyUser(req.headers.authorization)
    if (!user || !accessToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

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
