import type { VercelRequest, VercelResponse } from '@vercel/node'
import { randomUUID } from 'crypto'
import { verifyUser } from './_lib/verifyUser'
import { createUserScopedClient } from './_lib/supabaseServer'
import { createAdminClient } from './_lib/supabaseAdmin'
import { buildGoogleAuthUrl, exchangeCodeForTokens } from './_lib/googleCalendar'

interface AuthRequestBody {
  action?: string
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000

// Google's OAuth redirect_uri must exactly match what's registered in
// Google Cloud Console — kept as the original /api/google-callback path
// (vercel.json rewrites that path to this file) so the registered value
// never needs to change even though the handling code moved here.
function redirectUriFor(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
  return `${proto}://${req.headers.host}/api/google-callback`
}

function redirectToProfile(res: VercelResponse, status: 'connected' | 'error') {
  res.writeHead(302, { Location: `/profile?google=${status}` })
  res.end()
}

// Step 1 of the Google Calendar OAuth flow (PRD 6.2): mints a single-use
// state token linking this authorization attempt back to the signed-in
// user, then hands the client a Google consent URL to navigate to.
// GOOGLE_CLIENT_ID stays server-only (no VITE_ prefix) so the redirect
// URL is always built here, never assembled client-side.
async function handleGoogleAuthStart(req: VercelRequest, res: VercelResponse) {
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
    console.error('auth (google-start) failed to store oauth_states row', error)
    res.status(500).json({ error: 'Could not start Google connection' })
    return
  }

  const url = buildGoogleAuthUrl(state, redirectUriFor(req))
  res.status(200).json({ url })
}

// Step 2 of the Google Calendar OAuth flow: Google's redirect back into
// the app after the user approves/denies access. This request carries no
// Supabase session at all — it's a plain browser navigation Google
// initiated, not an authenticated API call — so it resolves which user
// via the opaque, single-use `state` value handleGoogleAuthStart minted,
// using the admin client narrowly for that lookup and the resulting
// token write (see api/_lib/supabaseAdmin.ts for why).
async function handleGoogleCallback(req: VercelRequest, res: VercelResponse) {
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
    console.error('auth (google-callback): token exchange returned no refresh_token')
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
    console.error('auth (google-callback) failed to store connection', error)
    redirectToProfile(res, 'error')
    return
  }

  redirectToProfile(res, 'connected')
}

// Consolidated auth endpoint (Vercel Hobby plan's 12-function cap, see
// README): the two steps of the Google Calendar OAuth flow share this
// file since one always follows the other. Routed by HTTP method rather
// than a body `action` field for the callback leg specifically, because
// that leg is a plain browser GET from Google carrying no body at all —
// only the start leg (a normal POST from our own frontend) uses `action`.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'GET') {
      await handleGoogleCallback(req, res)
      return
    }
    if (req.method === 'POST') {
      const body = req.body as AuthRequestBody
      if (body?.action === 'google-start') {
        await handleGoogleAuthStart(req, res)
        return
      }
      res.status(400).json({ error: 'Unknown or missing "action"' })
      return
    }
    res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    console.error('auth failed', err)
    if (req.method === 'GET') {
      redirectToProfile(res, 'error')
    } else {
      res.status(500).json({ error: 'Unexpected server error', detail: String(err) })
    }
  }
}
