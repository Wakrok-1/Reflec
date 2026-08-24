import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Handles the redirect back from Google OAuth. Supabase's client picks up
// the session from the URL automatically; this just waits for it and then
// routes into the app.
export function AuthCallback() {
  const navigate = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      navigate(data.session ? '/' : '/login', { replace: true })
    })
  }, [navigate])

  return (
    <div className="flex h-screen items-center justify-center text-reflection-400">
      Signing you in…
    </div>
  )
}
