import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import type { Memory, MemoryType, Snap } from '../lib/database.types'

const TYPE_LABELS: Record<MemoryType, string> = {
  EVENT: 'Things that happened',
  BELIEF: 'What you believe',
  GOAL: 'Active goals',
  PREFERENCE: 'Preferences',
  EMOTION: 'Emotions',
  HABIT: 'Habits',
  ACHIEVEMENT: 'Achievements',
  PROBLEM: 'Recurring struggles',
}

const TYPE_ORDER: MemoryType[] = [
  'BELIEF',
  'EMOTION',
  'HABIT',
  'PROBLEM',
  'GOAL',
  'PREFERENCE',
  'EVENT',
  'ACHIEVEMENT',
]

// PRD "Sprint 2 — Chat Core" item 9: transparency + control over what the
// AI has learned. Every memory is deletable; snaps can be marked private,
// which excludes them from future memory extraction and pattern analysis.
export function MemoryControls() {
  const { user } = useAuth()
  const [memories, setMemories] = useState<Memory[]>([])
  const [snaps, setSnaps] = useState<Snap[]>([])
  const [privateSnapIds, setPrivateSnapIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const load = async () => {
    if (!user) return
    setLoading(true)
    const [{ data: memoryRows }, { data: snapRows }, { data: privateRows }] = await Promise.all([
      supabase.from('memories').select('*').eq('user_id', user.id).order('last_seen_at', { ascending: false }),
      supabase.from('snaps').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('private_entries').select('entry_id').eq('user_id', user.id).eq('entry_type', 'snap'),
    ])
    setMemories(memoryRows ?? [])
    setSnaps(snapRows ?? [])
    setPrivateSnapIds(new Set((privateRows ?? []).map((r) => r.entry_id)))
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const deleteMemory = async (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id))
    await supabase.from('memories').delete().eq('id', id)
  }

  const togglePrivate = async (snapId: string) => {
    if (!user) return
    const isPrivate = privateSnapIds.has(snapId)
    setPrivateSnapIds((prev) => {
      const next = new Set(prev)
      if (isPrivate) next.delete(snapId)
      else next.add(snapId)
      return next
    })
    if (isPrivate) {
      await supabase
        .from('private_entries')
        .delete()
        .eq('user_id', user.id)
        .eq('entry_id', snapId)
        .eq('entry_type', 'snap')
    } else {
      await supabase.from('private_entries').insert({ user_id: user.id, entry_id: snapId, entry_type: 'snap' })
    }
  }

  const grouped = new Map<MemoryType, Memory[]>()
  for (const memory of memories) {
    const list = grouped.get(memory.type) ?? []
    list.push(memory)
    grouped.set(memory.type, list)
  }

  return (
    <section className="mt-6 rounded-xl border border-reflection-200 bg-white p-6">
      <h2 className="text-sm font-medium text-reflection-900">What does my AI know about me?</h2>
      <p className="mt-1 text-xs text-reflection-500">
        Everything Your Reflection has learned, grouped by type. Delete anything you don't want it
        carrying forward.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-reflection-400">Loading…</p>
      ) : memories.length === 0 ? (
        <p className="mt-4 text-sm italic text-reflection-400">
          Nothing yet — this fills in as you talk, journal, and snap.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {TYPE_ORDER.filter((type) => grouped.has(type)).map((type) => (
            <div key={type}>
              <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">
                {TYPE_LABELS[type]}
              </p>
              <ul className="mt-1.5 space-y-1">
                {grouped.get(type)!.map((memory) => (
                  <li key={memory.id} className="flex items-start justify-between gap-2 text-sm">
                    <span className="text-reflection-900">{memory.content}</span>
                    <button
                      onClick={() => deleteMemory(memory.id)}
                      className="shrink-0 text-xs text-reflection-400 hover:text-reflection-600"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 border-t border-reflection-100 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">Recent snaps</p>
        {snaps.length === 0 ? (
          <p className="mt-1.5 text-sm italic text-reflection-400">
            Nothing yet — snaps you save from chat will show up here.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {snaps.map((snap) => {
              const isPrivate = privateSnapIds.has(snap.id)
              return (
                <li key={snap.id} className="flex items-start justify-between gap-3 text-sm">
                  <span className={`${isPrivate ? 'text-reflection-400' : 'text-reflection-900'}`}>
                    {snap.content}
                  </span>
                  <button
                    onClick={() => togglePrivate(snap.id)}
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                      isPrivate
                        ? 'border-reflection-300 bg-reflection-100 text-reflection-700'
                        : 'border-reflection-200 text-reflection-500'
                    }`}
                  >
                    {isPrivate ? 'Private' : 'Mark private'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
