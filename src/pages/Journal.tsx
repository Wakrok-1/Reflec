import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Camera } from '@phosphor-icons/react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callApi } from '../lib/api'
import { PageShell } from '../components/layout/PageShell'
import { DoveLoader } from '../components/ui/DoveLoader'

type Mode = 'snap' | 'full'

interface EntryItem {
  kind: 'snap' | 'journal'
  id: string
  title: string | null
  content: string
  date: string
  createdAt: string
  aiReflection: string | null
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function Journal() {
  const { user } = useAuth()
  const [mode, setMode] = useState<Mode>('snap')

  const [snapContent, setSnapContent] = useState('')
  const [snapSaving, setSnapSaving] = useState(false)

  const [fullTitle, setFullTitle] = useState('')
  const [fullContent, setFullContent] = useState('')
  const [fullSaving, setFullSaving] = useState(false)
  const [reflecting, setReflecting] = useState(false)
  const [reflection, setReflection] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [entries, setEntries] = useState<EntryItem[]>([])
  const [privateIds, setPrivateIds] = useState<Set<string>>(new Set())
  const [loadingEntries, setLoadingEntries] = useState(true)
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null)

  const loadEntries = async () => {
    if (!user) return
    setLoadingEntries(true)
    const [{ data: snaps }, { data: journalEntries }, { data: privateRows }] = await Promise.all([
      supabase
        .from('snaps')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('journal_entries')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.from('private_entries').select('entry_id, entry_type').eq('user_id', user.id),
    ])

    const merged: EntryItem[] = [
      ...(snaps ?? []).map(
        (s): EntryItem => ({
          kind: 'snap',
          id: s.id,
          title: null,
          content: s.content,
          date: s.created_at.slice(0, 10),
          createdAt: s.created_at,
          aiReflection: null,
        }),
      ),
      ...(journalEntries ?? []).map(
        (j): EntryItem => ({
          kind: 'journal',
          id: j.id,
          title: j.title,
          content: j.content,
          date: j.entry_date,
          createdAt: j.created_at,
          aiReflection: j.ai_reflection,
        }),
      ),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

    setEntries(merged)
    setPrivateIds(
      new Set((privateRows ?? []).map((r) => `${r.entry_type === 'journal' ? 'journal' : 'snap'}:${r.entry_id}`)),
    )
    setLoadingEntries(false)
  }

  useEffect(() => {
    loadEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const queueBackgroundJobs = (entryId: string, entryType: 'journal_entries' | 'snaps', content: string) => {
    if (!user) return
    supabase.functions
      .invoke('embed-entry', { body: { userId: user.id, entryId, entryType, content } })
      .catch(() => {})
    supabase.functions.invoke('extract-patterns', { body: { userId: user.id, content } }).catch(() => {})
  }

  const submitSnap = async () => {
    if (!user || !snapContent.trim() || snapSaving) return
    setSnapSaving(true)
    const content = snapContent.trim()
    try {
      const { data: snap } = await supabase
        .from('snaps')
        .insert({ user_id: user.id, content })
        .select('id')
        .single()
      if (snap) queueBackgroundJobs(snap.id, 'snaps', content)
      setSnapContent('')
      await loadEntries()
    } finally {
      setSnapSaving(false)
    }
  }

  const submitFull = async () => {
    if (!user || !fullContent.trim() || fullSaving) return
    setFullSaving(true)
    setReflection(null)
    const content = fullContent.trim()
    const title = fullTitle.trim() || null
    try {
      const { data: entry } = await supabase
        .from('journal_entries')
        .insert({
          user_id: user.id,
          mode: 'full',
          title,
          content,
          source: 'manual',
          entry_date: new Date().toISOString().slice(0, 10),
        })
        .select('id')
        .single()

      if (entry) {
        queueBackgroundJobs(entry.id, 'journal_entries', content)
        setFullTitle('')
        setFullContent('')
        await loadEntries()

        setReflecting(true)
        try {
          const { reflection: reflectionText } = await callApi<{ reflection: string | null }>(
            '/api/journal-reflect',
            { entryId: entry.id, content },
          )
          setReflection(reflectionText)
          if (reflectionText) await loadEntries()
        } finally {
          setReflecting(false)
        }
      }
    } finally {
      setFullSaving(false)
    }
  }

  const handleImageUpload = async (file: File) => {
    setUploading(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const { content, date } = await callApi<{ content: string; date: string | null }>('/api/vision-extract', {
        imageDataUrl: dataUrl,
      })
      setFullContent((prev) => (prev ? `${prev}\n\n${content}` : content))
      void date
    } catch {
      // Extraction failing shouldn't block the user from writing manually.
    } finally {
      setUploading(false)
    }
  }

  const turnIntoJournal = async (item: EntryItem) => {
    setBusyEntryId(item.id)
    try {
      const sameDaySnapIds = entries.filter((e) => e.kind === 'snap' && e.date === item.date).map((e) => e.id)
      await callApi('/api/turn-into-journal', { snapIds: sameDaySnapIds })
      await loadEntries()
    } finally {
      setBusyEntryId(null)
    }
  }

  const distillToSnap = async (item: EntryItem) => {
    setBusyEntryId(item.id)
    try {
      await callApi('/api/distill-to-snap', { entryId: item.id })
      await loadEntries()
    } finally {
      setBusyEntryId(null)
    }
  }

  const togglePrivate = async (item: EntryItem) => {
    if (!user) return
    const entryType = item.kind === 'journal' ? 'journal' : 'snap'
    const key = `${entryType}:${item.id}`
    const isPrivate = privateIds.has(key)
    setPrivateIds((prev) => {
      const next = new Set(prev)
      if (isPrivate) next.delete(key)
      else next.add(key)
      return next
    })
    if (isPrivate) {
      await supabase
        .from('private_entries')
        .delete()
        .eq('user_id', user.id)
        .eq('entry_id', item.id)
        .eq('entry_type', entryType)
    } else {
      await supabase.from('private_entries').insert({ user_id: user.id, entry_id: item.id, entry_type: entryType })
    }
  }

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="flex justify-center gap-1 rounded-pill border border-hair border-[rgba(180,170,158,0.3)] bg-white p-1">
          <button
            onClick={() => setMode('snap')}
            className={`flex-1 rounded-pill py-2 text-xs font-medium transition-colors ${
              mode === 'snap' ? 'text-white' : 'text-stone'
            }`}
            style={mode === 'snap' ? { background: 'var(--gradient-stone)' } : undefined}
          >
            Snap
          </button>
          <button
            onClick={() => setMode('full')}
            className={`flex-1 rounded-pill py-2 text-xs font-medium transition-colors ${
              mode === 'full' ? 'text-white' : 'text-stone'
            }`}
            style={mode === 'full' ? { background: 'var(--gradient-stone)' } : undefined}
          >
            Full entry
          </button>
        </div>

        {mode === 'snap' ? (
          <div className="mt-4">
            <textarea
              value={snapContent}
              onChange={(e) => setSnapContent(e.target.value)}
              placeholder="whatever's on your mind..."
              rows={6}
              className="w-full resize-none rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white p-4 text-[13px] text-charcoal outline-none placeholder:text-warm-muted"
            />
            <button
              onClick={submitSnap}
              disabled={!snapContent.trim() || snapSaving}
              className="mt-2 rounded-pill px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--gradient-user-bubble)' }}
            >
              {snapSaving ? 'Saving…' : 'Save snap'}
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <input
              value={fullTitle}
              onChange={(e) => setFullTitle(e.target.value)}
              placeholder="Title (optional)"
              className="w-full rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white px-4 py-2.5 text-[13px] text-charcoal outline-none placeholder:text-warm-muted"
            />
            <textarea
              value={fullContent}
              onChange={(e) => setFullContent(e.target.value)}
              placeholder="write freely..."
              rows={10}
              className="mt-2 w-full resize-none rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white p-4 text-[13px] leading-[1.7] text-charcoal outline-none placeholder:text-warm-muted"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImageUpload(file)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-3 py-2 text-xs text-stone disabled:opacity-50"
              >
                <Camera size={13} />
                {uploading ? 'Reading screenshot…' : 'Apple Journal screenshot'}
              </button>
              <button
                onClick={submitFull}
                disabled={!fullContent.trim() || fullSaving}
                className="rounded-pill px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--gradient-user-bubble)' }}
              >
                {fullSaving ? 'Saving…' : 'Save entry'}
              </button>
            </div>

            {reflecting && <DoveLoader label="Your Reflection is reading..." />}
            {!reflecting && reflection && (
              <div className="chat-message-in relative mt-3 max-w-[92%] rounded-bubble rounded-bl-[4px] border border-hair border-[rgba(180,170,158,0.25)] bg-white px-3.5 py-[11px] text-[13px] text-charcoal">
                {reflection}
                <button
                  onClick={() => setReflection(null)}
                  aria-label="Dismiss reflection"
                  className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-cream text-[10px] text-stone shadow-sm"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 space-y-3">
          {loadingEntries ? (
            <p className="text-sm text-warm-muted">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm italic text-warm-muted">
              Nothing here yet — write your first entry above.
            </p>
          ) : (
            entries.map((item) => {
              const entryType = item.kind === 'journal' ? 'journal' : 'snap'
              const isPrivate = privateIds.has(`${entryType}:${item.id}`)
              const busy = busyEntryId === item.id
              return (
                <div
                  key={`${item.kind}-${item.id}`}
                  className="rounded-card border border-hair border-[rgba(180,170,158,0.3)] bg-cream p-4"
                >
                  <p className="text-[10px] font-medium uppercase tracking-wide text-stone">
                    {formatDate(item.date)} · {item.kind === 'journal' ? 'Journal' : 'Snap'}
                  </p>
                  {item.title && <p className="mt-1 text-[15px] font-medium text-charcoal">{item.title}</p>}
                  <p className="mt-1 line-clamp-2 text-[13px] leading-[1.6] text-charcoal">{item.content}</p>
                  {item.aiReflection && (
                    <p className="mt-2 border-l-2 border-[rgba(180,170,158,0.3)] pl-2 text-xs italic text-warm-muted">
                      {item.aiReflection}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-3">
                    {item.kind === 'snap' && (
                      <button
                        onClick={() => turnIntoJournal(item)}
                        disabled={busy}
                        className="text-xs font-medium text-stone underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        {busy ? 'Working…' : 'Turn into journal'}
                      </button>
                    )}
                    {item.kind === 'journal' && (
                      <button
                        onClick={() => distillToSnap(item)}
                        disabled={busy}
                        className="text-xs font-medium text-stone underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        {busy ? 'Working…' : 'Distill to snap'}
                      </button>
                    )}
                    <button
                      onClick={() => togglePrivate(item)}
                      className="text-xs font-medium text-stone underline-offset-2 hover:underline"
                    >
                      {isPrivate ? 'Private' : 'Mark private'}
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="mt-6 flex justify-center">
          <Link
            to="/journal/export"
            className="rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-4 py-2 text-xs font-medium text-stone"
          >
            Export to PDF
          </Link>
        </div>
      </div>
    </PageShell>
  )
}
