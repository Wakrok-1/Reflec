import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export function Signup() {
  const { session, signUpWithEmail, signInWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmSent, setConfirmSent] = useState(false)

  if (session) return <Navigate to="/" replace />

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await signUpWithEmail(email, password)
    setSubmitting(false)
    if (error) {
      setError(error)
      return
    }
    setConfirmSent(true)
  }

  const handleGoogle = async () => {
    setError(null)
    const { error } = await signInWithGoogle()
    if (error) setError(error)
  }

  if (confirmSent) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="text-xl font-semibold text-reflection-900">Almost there</h1>
          <p className="text-sm text-reflection-500">
            Check {email} for a confirmation link to finish creating your account.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-reflection-900">Your Reflection</h1>
          <p className="mt-1 text-sm text-reflection-500">Let's get to know you.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-reflection-200 px-3 py-2 text-sm outline-none focus:border-reflection-500"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-reflection-200 px-3 py-2 text-sm outline-none focus:border-reflection-500"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-reflection-600 px-3 py-2 text-sm font-medium text-white hover:bg-reflection-700 disabled:opacity-50"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="flex items-center gap-3 text-xs text-reflection-400">
          <div className="h-px flex-1 bg-reflection-200" />
          or
          <div className="h-px flex-1 bg-reflection-200" />
        </div>

        <button
          onClick={handleGoogle}
          className="w-full rounded-lg border border-reflection-200 px-3 py-2 text-sm font-medium text-reflection-700 hover:bg-reflection-100"
        >
          Continue with Google
        </button>

        <p className="text-center text-sm text-reflection-500">
          Already have an account?{' '}
          <Link to="/login" className="text-reflection-600 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
