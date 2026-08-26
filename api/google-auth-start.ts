import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomUUID } from 'crypto'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { buildGoogleAuthUrl } from './_lib/googleCalendar'

function redirectUriFor(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
  return `${proto}://${req.headers.host}/api/google-callback`
}

// Step 1 of the Google Calendar OAuth flow (PRD 6.2): mints a single-use
// state token linking this authorization attempt back to the signed-in
// user, then hands the client a Google consent URL to navigate to.
// GOOGLE_CLIENT_ID stays server-only (no VITE_ prefix) so the redirect
// URL is always built here, never assembled client-side.
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
    const state = randomUUID()
    const { error } = await supabase.from('oauth_states').insert({ state, user_id: user.id, provider: 'google' })
    if (error) {
      console.error('google-auth-start failed to store oauth_states row', error)
      res.status(500).json({ error: 'Could not start Google connection' })
      return
    }

    const url = buildGoogleAuthUrl(state, redirectUriFor(req))
    res.status(200).json({ url })
  } catch (err) {
    console.error('google-auth-start failed', err)
    res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
  }
}
