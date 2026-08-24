import type { Suggestion } from '../types/suggestions'

function describe(s: Suggestion): { title: string; detail: string } {
  if (s.type === 'profile_field') {
    const value = Array.isArray(s.value) ? s.value.join(', ') : String(s.value)
    return { title: s.label, detail: value }
  }
  return {
    title: `${s.category[0].toUpperCase()}${s.category.slice(1)}: ${s.item}`,
    detail: s.context ?? '',
  }
}

interface SuggestionBubbleProps {
  suggestion: Suggestion
  onAccept: (s: Suggestion) => void
  onDismiss: (s: Suggestion) => void
  busy?: boolean
}

// The approval bubble described throughout the PRD (5.2, 7.3): every AI
// suggestion — a profile trait, a taste entry — surfaces here, and the
// user taps Accept or Dismiss. Dismissed suggestions are never
// re-surfaced (handled by the caller via dismissed_suggestions).
export function SuggestionBubble({ suggestion, onAccept, onDismiss, busy }: SuggestionBubbleProps) {
  const { title, detail } = describe(suggestion)

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-reflection-200 bg-reflection-50 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-reflection-900">{title}</p>
        {detail && <p className="mt-0.5 break-words text-sm text-reflection-500">{detail}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          disabled={busy}
          onClick={() => onDismiss(suggestion)}
          className="rounded-lg border border-reflection-200 px-2.5 py-1 text-xs font-medium text-reflection-500 hover:bg-white disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          disabled={busy}
          onClick={() => onAccept(suggestion)}
          className="rounded-lg bg-reflection-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-reflection-700 disabled:opacity-50"
        >
          Accept
        </button>
      </div>
    </div>
  )
}
