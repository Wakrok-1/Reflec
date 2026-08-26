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
  // Read as text first — a platform-level failure (a crashed function, a
  // timeout, a proxy error page) can return plain text/HTML instead of
  // JSON, and calling response.json() directly on that throws an opaque
  // SyntaxError instead of a message that explains what actually happened.
  const raw = await response.text()
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    throw new Error(
      `Request to ${path} failed (${response.status}): ${raw.slice(0, 200) || 'empty response'}`,
    )
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request to ${path} failed`
    throw new Error(message)
  }
  return data as T
}
