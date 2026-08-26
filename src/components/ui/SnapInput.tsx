import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'

// Snap journal quick entry (design spec section 5.3, PRD 5.4 Snap Mode):
// no title, no word count, no formatting pressure. Submits straight to
// the snaps table; tagging happens quietly in the background — the user
// never sees it unless they ask.
export function SnapInput() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!user || !content.trim() || submitting) return
    setSubmitting(true)
    const text = content.trim()
    try {
      const { data: snap } = await supabase
        .from('snaps')
        .insert({ user_id: user.id, content: text })
        .select('id')
        .single()

      if (snap) {
        // Background tagging — fire and forget, never blocks the UI.
        supabase.functions
          .invoke('embed-entry', {
            body: { userId: user.id, entryId: snap.id, entryType: 'snaps', content: text },
          })
          .catch(() => {})
        supabase.functions.invoke('extract-patterns', { body: { userId: user.id, content: text } }).catch(() => {})
      }

      setContent('')
      setOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 whitespace-nowrap rounded-pill border border-hair border-[rgba(138,122,106,0.2)] px-3 py-2 text-xs font-medium text-[#6B5E52]"
        style={{ background: 'rgba(138,122,106,0.1)' }}
      >
        ⚡ Snap
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/20 px-4 pb-32 sm:items-center sm:pb-4">
          <div className="slide-up-fade-in w-full max-w-md rounded-card-lg border border-hair border-[rgba(180,170,158,0.3)] bg-cream p-4">
            <textarea
              autoFocus
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="whatever's on your mind..."
              rows={4}
              className="w-full resize-none rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white p-3 text-[13px] text-charcoal outline-none placeholder:text-warm-muted"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => {
                  setContent('')
                  setOpen(false)
                }}
                className="rounded-pill px-3 py-1.5 text-xs text-stone"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!content.trim() || submitting}
                className="rounded-pill px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--gradient-user-bubble)' }}
              >
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
