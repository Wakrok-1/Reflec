import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useProfile } from '../hooks/useProfile'
import { supabase } from '../lib/supabase'

export function Home() {
  const { user, signOut } = useAuth()
  const { profile, loading } = useProfile()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const runGroqTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const response = await fetch('/api/groq-test', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      const raw = await response.text()
      let data: { message?: string; error?: string }
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        throw new Error(`Non-JSON response (${response.status}): ${raw.slice(0, 200) || 'empty response'}`)
      }
      setResult(response.ok ? (data.message ?? 'OK') : `Error: ${data.error}`)
    } catch (err) {
      setResult(`Error: ${String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-reflection-400">Loading…</div>
    )
  }

  if (profile && !profile.onboarding_completed_at) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-reflection-900">Your Reflection</h1>
          <p className="truncate text-sm text-reflection-500">Signed in as {user?.email}</p>
        </div>
        <button
          onClick={signOut}
          className="shrink-0 rounded-lg border border-reflection-200 px-3 py-1.5 text-sm text-reflection-700 hover:bg-reflection-100"
        >
          Sign out
        </button>
      </div>

      <div className="mt-6 flex gap-3">
        <Link
          to="/chat"
          className="inline-block rounded-lg bg-reflection-600 px-4 py-2 text-sm font-medium text-white hover:bg-reflection-700"
        >
          Open Chat
        </Link>
        <Link
          to="/profile"
          className="inline-block rounded-lg border border-reflection-200 bg-white px-4 py-2 text-sm font-medium text-reflection-700 hover:bg-reflection-100"
        >
          Open Character Profile
        </Link>
      </div>

      <div className="mt-6 rounded-xl border border-reflection-200 bg-white p-6">
        <h2 className="text-sm font-medium text-reflection-900">Sprint foundation check</h2>
        <p className="mt-1 text-sm text-reflection-500">
          Chat, journaling, goals, and the rest of the app land in later sprints. For now, this
          confirms Groq API connectivity end to end.
        </p>
        <button
          onClick={runGroqTest}
          disabled={testing}
          className="mt-4 rounded-lg bg-reflection-600 px-3 py-2 text-sm font-medium text-white hover:bg-reflection-700 disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test Groq connection'}
        </button>
        {result && <p className="mt-3 text-sm text-reflection-700">{result}</p>}
      </div>
    </div>
  )
}
