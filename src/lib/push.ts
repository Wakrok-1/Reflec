import { supabase } from './supabase'

// Web Push subscribe/unsubscribe (Sprint 5, PRD "Web Push Notifications").
// VITE_VAPID_PUBLIC_KEY must be set to the same value as the server-side
// VAPID_PUBLIC_KEY env var — the public half of a VAPID key pair is
// meant to reach the browser (that's how applicationServerKey works),
// unlike VAPID_PRIVATE_KEY which never leaves the server.

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)))
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

// Registers the service worker, requests notification permission, and
// stores the resulting subscription on the user's profile row. Returns
// false (never throws) on anything short of success — unsupported
// browser, permission denied, missing VAPID key — so callers can just
// show "notifications aren't available" rather than handle an exception.
export async function subscribeToPush(userId: string): Promise<boolean> {
  if (!pushSupported()) return false
  const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (!publicKey) return false

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false

  const registration = await navigator.serviceWorker.register('/sw.js')
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Push subscription is missing required fields')
  }

  await supabase
    .from('profiles')
    .update({
      push_subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    })
    .eq('id', userId)
  return true
}

export async function unsubscribeFromPush(userId: string): Promise<void> {
  if (!pushSupported()) return
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  const subscription = await registration?.pushManager.getSubscription()
  await subscription?.unsubscribe()
  await supabase.from('profiles').update({ push_subscription: null }).eq('id', userId)
}
