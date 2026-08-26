import webpush from 'web-push'
import type { PushSubscriptionJson } from '../../src/lib/database.types'

let configured = false

function ensureConfigured() {
  if (configured) return
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    throw new Error('Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY')
  }
  // mailto: is required by the Web Push protocol as a contact point for
  // push services that need to reach the sender — not a real inbox.
  webpush.setVapidDetails('mailto:support@yourreflection.app', publicKey, privateKey)
  configured = true
}

export interface PushPayload {
  title: string
  body: string
}

// Sends one push notification. Returns false (never throws) on a dead
// subscription (410 Gone / 404) so callers can prune it — anything else
// still throws, since that's a real, unexpected failure worth surfacing.
export async function sendPush(subscription: PushSubscriptionJson, payload: PushPayload): Promise<boolean> {
  ensureConfigured()
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload))
    return true
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode === 404 || statusCode === 410) return false
    throw err
  }
}
