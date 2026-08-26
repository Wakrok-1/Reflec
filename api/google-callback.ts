import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createAdminClient } from './_lib/supabaseAdmin'
import { exchangeCodeForTokens } from './_lib/googleCalendar'

const STATE_MAX_AGE_MS = 10 * 60 * 1000

function redirectUriFor(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
  return `${proto}://${req.headers.host}/api/google-callback`
}

function redirectToProfile(res: VercelResponse, status: 'connected' | 'error') {
  res.writeHead(302, { Location: `/profile?google=${status}` })
  res.end()
}

// Step 2 of the Google Calendar OAuth flow: Google's redirect back into
// the app after the user approves/denies access. This request carries no
// Supabase session at all — it's a plain browser navigation Google
// initiated, not an authenticated API call — so it resolves which user
// via the opaque, single-use `state` value api/google-auth-start.ts
// minted, using the admin client narrowly for that lookup and the
// resulting token write (see api/_lib/supabaseAdmin.ts for why).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : null
    const state = typeof req.query.state === 'string' ? req.query.state : null
    if (!code || !state) {
      redirectToProfile(res, 'error')
      return
    }

    const admin = createAdminClient()
    const { data: stateRow } = await admin.from('oauth_states').select('*').eq('state', state).maybeSingle()
    if (!stateRow) {
      redirectToProfile(res, 'error')
      return
    }
    // Single-use: delete immediately, whether or not the exchange below succeeds.
    await admin.from('oauth_states').delete().eq('state', state)

    const stateAgeMs = Date.now() - new Date(stateRow.created_at).getTime()
    if (stateAgeMs > STATE_MAX_AGE_MS) {
      redirectToProfile(res, 'error')
      return
    }

    const tokens = await exchangeCodeForTokens(code, redirectUriFor(req))
    if (!tokens.refresh_token) {
      // Google only returns a refresh_token on first consent — prompt=consent
      // in buildGoogleAuthUrl forces this, but guard anyway: without one we
      // can't refresh later and shouldn't claim to be connected.
      console.error('google-callback: token exchange returned no refresh_token')
      redirectToProfile(res, 'error')
      return
    }

    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    const { error } = await admin.from('google_calendar_connections').upsert({
      user_id: stateRow.user_id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: tokenExpiresAt,
      scope: tokens.scope,
    })
    if (error) {
      console.error('google-callback failed to store connection', error)
      redirectToProfile(res, 'error')
      return
    }

    redirectToProfile(res, 'connected')
  } catch (err) {
    console.error('google-callback failed', err)
    redirectToProfile(res, 'error')
  }
}
