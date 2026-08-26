import { createClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types'

// The ONE deliberate exception to this app's "never a service-role key"
// rule (see README "Security notes"). Every normal /api/* function runs
// scoped to the caller's own JWT via createUserScopedClient, so RLS is
// the real boundary — but two call sites genuinely have no user JWT to
// scope to, because they aren't user-initiated HTTP requests at all:
//
//   1. api/google-callback.ts — Google's OAuth redirect carries no
//      Supabase session; the only proof of "which user" is possession of
//      the opaque, single-use `state` value this app minted and handed
//      to Google (see oauth_states in 0006_sprint5_integrations.sql).
//   2. api/cron/daily-checkin.ts — a Vercel Cron invocation, gated by
//      CRON_SECRET, that must read across *all* users to decide who's
//      due for a notification. There is no per-request user to scope to.
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
