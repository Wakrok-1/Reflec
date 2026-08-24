import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export function Home() {
  const { user, signOut } = useAuth()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const runClaudeTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const response = await fetch('/api/claude-test', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      const data = await response.json()
      setResult(response.ok ? data.message : `Error: ${data.error}`)
    } catch (err) {
      setResult(`Error: ${String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-reflection-900">Your Reflection</h1>
          <p className="text-sm text-reflection-500">Signed in as {user?.email}</p>
        </div>
        <button
          onClick={signOut}
          className="rounded-lg border border-reflection-200 px-3 py-1.5 text-sm text-reflection-700 hover:bg-reflection-100"
        >
          Sign out
        </button>
      </div>

      <div className="mt-10 rounded-xl border border-reflection-200 bg-white p-6">
        <h2 className="text-sm font-medium text-reflection-900">Sprint 0 — Foundation check</h2>
        <p className="mt-1 text-sm text-reflection-500">
          Chat, journaling, goals, and the rest of the app land in later sprints. For now, this
          confirms Claude API connectivity end to end.
        </p>
        <button
          onClick={runClaudeTest}
          disabled={testing}
          className="mt-4 rounded-lg bg-reflection-600 px-3 py-2 text-sm font-medium text-white hover:bg-reflection-700 disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test Claude connection'}
        </button>
        {result && <p className="mt-3 text-sm text-reflection-700">{result}</p>}
      </div>
    </div>
  )
}
