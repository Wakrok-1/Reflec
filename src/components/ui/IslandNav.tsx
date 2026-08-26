import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

// Dynamic island navbar — the app's only navigation element (design spec
// section 5.2). Floats at the bottom of every page and "breathes" open
// with a spring animation on tap before settling back.
const ITEMS = [
  { key: 'chat', label: 'chat', path: '/chat' },
  { key: 'journal', label: 'journal', path: '/journal' },
  { key: 'goals', label: 'goals', path: '/goals' },
  { key: 'you', label: 'you', path: '/profile' },
] as const

const BREATHE_MS = 400

export function IslandNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const [breathing, setBreathing] = useState(false)

  const handleNavigate = (path: string) => {
    setBreathing(true)
    navigate(path)
    setTimeout(() => setBreathing(false), BREATHE_MS)
  }

  return (
    <nav
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center overflow-hidden rounded-island border-hair border-[rgba(255,255,255,0.08)] transition-all"
      style={{
        background: 'linear-gradient(135deg, rgba(40,36,32,0.92), rgba(55,48,42,0.95))',
        gap: breathing ? '2rem' : '1.25rem',
        padding: breathing ? '12px 30px' : '10px 24px',
        transitionDuration: '400ms',
        transitionTimingFunction: 'cubic-bezier(0.34,1.56,0.64,1)',
      }}
    >
      <span className="island-shimmer pointer-events-none absolute inset-0" />
      {ITEMS.map((item) => {
        const active = location.pathname === item.path
        return (
          <button
            key={item.key}
            onClick={() => handleNavigate(item.path)}
            className="relative flex flex-col items-center gap-1"
          >
            <span
              className={`font-poppins text-xs font-medium transition-colors ${
                active ? 'text-white' : 'text-[rgba(255,255,255,0.4)]'
              }`}
            >
              {item.label}
            </span>
            {active && (
              <span
                className="h-1 w-1 rounded-full"
                style={{ background: 'linear-gradient(90deg, #818cf8, #c084fc)' }}
              />
            )}
          </button>
        )
      })}
    </nav>
  )
}
