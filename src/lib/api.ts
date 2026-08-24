import { supabase } from './supabase'

// Calls one of our /api/* Vercel serverless functions with the current
// Supabase session token attached, so the function can verify the caller
// before doing anything (see api/_lib/verifyUser.ts).
export async function callApi<T>(path: string, body: unknown): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error ?? `Request to ${path} failed`)
  }
  return data as T
}
