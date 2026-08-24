import { createClient } from '@supabase/supabase-js'

// Verifies the Supabase access token a client sent in the Authorization
// header. Uses the anon key (not the service role key) — this only checks
// "is this a real, currently-valid session", it does not bypass RLS.
export async function verifyUser(authHeader: string | undefined) {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return null

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return null

  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}
