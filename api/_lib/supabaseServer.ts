import { createClient } from '@supabase/supabase-js'
import type { Database } from '../../src/lib/database.types'

// A Supabase client scoped to the caller's own access token — every
// request it makes (including .rpc() and .from() queries) carries that
// user's JWT, so row-level security resolves auth.uid() correctly. This
// app never uses a service-role key: server code reads/writes exactly
// what RLS already allows the signed-in user to touch.
export function createUserScopedClient(accessToken: string) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
  }

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
