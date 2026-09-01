import { createClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types'

// The ONE deliberate exception to this app's "never a service-role key"
// rule (see README "Security notes"). Every normal /api/* function runs
// scoped to the caller's own JWT via createUserScopedClient, so RLS is
// the real boundary — but two call sites genuinely have no user JWT to
// scope to, because they aren't user-initiated HTTP requests at all:
//
//   1. api/auth.ts's Google callback path — Google's OAuth redirect
//      carries no Supabase session; the only proof of "which user" is
//      possession of the opaque, single-use `state` value this app
//      minted and handed to Google (see oauth_states in
//      0006_sprint5_integrations.sql).
//   2. api/notifications.ts's trusted path — called by the Supabase
//      daily-checkin Edge Function (itself invoked by pg_cron, see
//      0007_pg_cron_daily_checkin.sql), authenticated with CRON_SECRET
//      rather than a session, to look up an arbitrary user's push
//      subscription. The cross-account "who's due for a notification"
//      decision happens in that Edge Function instead, using its own
//      SUPABASE_SERVICE_ROLE_KEY (Supabase auto-injects this into every
//      Edge Function) — not this file, which is Node-only.
//
// Both call sites must explicitly filter every query by the specific
// user_id they've resolved through their own narrow, documented
// mechanism above — this client has no RLS safety net, unlike every
// other Supabase client in this codebase.
export function createAdminClient() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
