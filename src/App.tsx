import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AuthCallback } from './pages/AuthCallback'
import { CharacterProfile } from './pages/CharacterProfile'
import { Chat } from './pages/Chat'
import { Goals } from './pages/Goals'
import { Home } from './pages/Home'
import { Journal } from './pages/Journal'
import { Login } from './pages/Login'
import { Onboarding } from './pages/Onboarding'
import { Signup } from './pages/Signup'

// @react-pdf/renderer pulls in a full PDF layout engine (~1.2MB) — code
// split so it only loads for people who actually open the export builder.
const JournalExport = lazy(() => import('./pages/JournalExport').then((m) => ({ default: m.JournalExport })))

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <Onboarding />
          </ProtectedRoute>
        }
      />
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <CharacterProfile />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chat"
        element={
          <ProtectedRoute>
            <Chat />
          </ProtectedRoute>
        }
      />
      <Route
        path="/journal"
        element={
          <ProtectedRoute>
            <Journal />
          </ProtectedRoute>
        }
      />
      <Route
        path="/journal/export"
        element={
          <ProtectedRoute>
            <Suspense fallback={<div className="flex h-screen items-center justify-center text-warm-muted">Loading export builder…</div>}>
              <JournalExport />
            </Suspense>
          </ProtectedRoute>
        }
      />
      <Route
        path="/goals"
        element={
          <ProtectedRoute>
            <Goals />
          </ProtectedRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Home />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}
