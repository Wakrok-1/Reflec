import { useRef, useState } from 'react'

// AI and user chat bubble variants (design spec section 5.3). AI bubbles
// carry the silent "felt right" affordance: a dove icon that appears on
// hover (desktop) or long-press (mobile) at the edge of the bubble.
// Tapping it sends a positive signal — no rating, no confirmation, just a
// brief pulse before it disappears.
interface ChatBubbleProps {
  role: 'user' | 'assistant'
  content: string
  feltRight?: boolean
  onFeltRight?: () => void
}

const LONG_PRESS_MS = 450

export function ChatBubble({ role, content, feltRight, onFeltRight }: ChatBubbleProps) {
  const [pressing, setPressing] = useState(false)
  const [pulsing, setPulsing] = useState(false)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (role === 'user') {
    return (
      <div
        className="chat-message-in max-w-[88%] rounded-bubble rounded-br-[4px] px-3.5 py-[11px] text-[13px] text-white"
        style={{ background: 'var(--gradient-user-bubble)' }}
      >
        {content}
      </div>
    )
  }

  const startLongPress = () => {
    pressTimer.current = setTimeout(() => setPressing(true), LONG_PRESS_MS)
  }
  const cancelLongPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
  }

  const handleFeltRight = () => {
    setPulsing(true)
    onFeltRight?.()
    setTimeout(() => {
      setPulsing(false)
      setPressing(false)
    }, 400)
  }

  const showAffordance = !feltRight && (pressing || undefined)

  return (
    <div
      className="group chat-message-in relative max-w-[88%] rounded-bubble rounded-bl-[4px] border border-hair border-[rgba(180,170,158,0.25)] bg-white px-3.5 py-[11px] text-[13px] text-charcoal"
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
    >
      {content}
      {!feltRight && (
        <button
          aria-label="This felt right"
          onClick={handleFeltRight}
          className={`absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-cream text-xs shadow-sm transition-opacity duration-200 ${
            showAffordance ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          } ${pulsing ? 'felt-right-pulse' : ''}`}
        >
          🕊
        </button>
      )}
    </div>
  )
}
