// Service worker for Web Push (Sprint 5). Registered by src/lib/push.ts.
// No offline caching / asset strategy here — its only job is receiving
// push events and showing the notification.

self.addEventListener('push', (event) => {
  let data = { title: 'Your Reflection', body: '' }
  try {
    if (event.data) data = event.data.json()
  } catch {
    if (event.data) data = { title: 'Your Reflection', body: event.data.text() }
  }

  event.waitUntil(self.registration.showNotification(data.title, { body: data.body }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow('/')
    }),
  )
})
