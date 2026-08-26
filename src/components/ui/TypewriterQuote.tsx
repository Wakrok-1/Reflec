import { useEffect, useState } from 'react'

// Animated quote header for the chat page (design spec section 5.3):
// types out character by character, 40ms per char, cursor blinks 3x then
// fades once typing completes.
interface TypewriterQuoteProps {
  quote: string
}

const MS_PER_CHAR = 40

export function TypewriterQuote({ quote }: TypewriterQuoteProps) {
  const [shown, setShown] = useState(0)
  const [cursorFaded, setCursorFaded] = useState(false)

  useEffect(() => {
    setShown(0)
    setCursorFaded(false)
    const interval = setInterval(() => {
      setShown((prev) => {
        if (prev >= quote.length) {
          clearInterval(interval)
          return prev
        }
        return prev + 1
      })
    }, MS_PER_CHAR)
    return () => clearInterval(interval)
  }, [quote])

  useEffect(() => {
    if (shown < quote.length) return
    const fadeTimer = setTimeout(() => setCursorFaded(true), 800 * 3)
    return () => clearTimeout(fadeTimer)
  }, [shown, quote.length])

  return (
    <div className="border-b border-hair border-[rgba(180,170,158,0.3)] px-4 py-3 text-center">
      <p className="font-poppins text-xs font-light italic leading-[1.6] text-warm-muted">
        {quote.slice(0, shown)}
        <span className={`typewriter-cursor${cursorFaded ? ' faded' : ''}`}>|</span>
      </p>
    </div>
  )
}
