import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useProfile } from '../hooks/useProfile'
import { supabase } from '../lib/supabase'
import { ConnectedApps } from '../components/ConnectedApps'
import { MemoryControls } from '../components/MemoryControls'
import { SuggestionBubble } from '../components/SuggestionBubble'
import { dismissSuggestion, fetchDismissedFingerprints, isDismissed } from '../lib/suggestions'
import type { Profile, TasteCategory, TasteProfileItem } from '../lib/database.types'
import type { OnboardingExtraction } from '../types/onboarding'
import type { ProfileFieldSuggestion, Suggestion, TasteEntrySuggestion } from '../types/suggestions'

const TASTE_CATEGORIES: { key: TasteCategory; label: string; emptyHint: string }[] = [
  {
    key: 'music',
    label: 'Music',
    emptyHint: 'Nothing yet — the tracks you turn to will show up here once you mention them.',
  },
  {
    key: 'books',
    label: 'Books & Writing',
    emptyHint: 'Nothing yet — the stories that stick with you will show up here.',
  },
  {
    key: 'sport',
    label: 'Sport & Movement',
    emptyHint: 'Nothing yet — how you move, and why, shows up here over time.',
  },
  { key: 'food', label: 'Food', emptyHint: 'Nothing yet — what you crave in different moods shows up here.' },
  {
    key: 'aesthetics',
    label: 'Aesthetics',
    emptyHint: "Nothing yet — the colours and spaces you're drawn to show up here.",
  },
  { key: 'hobbies', label: 'Hobbies', emptyHint: 'Nothing yet — what you do with free time shows up here.' },
  {
    key: 'symbols',
    label: 'Recurring Symbols',
    emptyHint: 'Nothing yet — words and images that keep appearing in your writing show up here.',
  },
]

function buildSuggestions(extraction: OnboardingExtraction): Suggestion[] {
  const out: Suggestion[] = []
  const p = extraction.profile

  if (p.name) out.push({ type: 'profile_field', id: 'sugg-name', field: 'name', label: 'Name', value: p.name })
  if (p.age != null) out.push({ type: 'profile_field', id: 'sugg-age', field: 'age', label: 'Age', value: p.age })
  if (p.class)
    out.push({ type: 'profile_field', id: 'sugg-class', field: 'class', label: 'Class', value: p.class })
  if (p.philosophy)
    out.push({
      type: 'profile_field',
      id: 'sugg-philosophy',
      field: 'philosophy',
      label: 'Personal Philosophy',
      value: p.philosophy,
    })
  p.strengths.forEach((s) =>
    out.push({ type: 'profile_field', id: `sugg-strength-${s}`, field: 'strengths', label: 'Strength', value: s }),
  )
  p.core_values.forEach((v) =>
    out.push({ type: 'profile_field', id: `sugg-value-${v}`, field: 'core_values', label: 'Core Value', value: v }),
  )
  // Taste is written directly to taste_profile on onboarding completion
  // (PRD 5.2: it "never fills a form"), not gated behind a bubble here —
  // suggestion bubbles for taste are reserved for what the AI notices
  // later, in ongoing chat.

  return out
}

export function CharacterProfile() {
  const { user } = useAuth()
  const { profile, refresh } = useProfile()
  const location = useLocation()
  const extraction = (location.state as { extraction?: OnboardingExtraction } | null)?.extraction

  const [pending, setPending] = useState<Suggestion[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [taste, setTaste] = useState<TasteProfileItem[]>([])

  const loadTaste = async () => {
    if (!user) return
    const { data } = await supabase
      .from('taste_profile')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
    setTaste(data ?? [])
  }

  useEffect(() => {
    loadTaste()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  useEffect(() => {
    if (!extraction || !user) return
    ;(async () => {
      const dismissed = await fetchDismissedFingerprints(user.id)
      const all = buildSuggestions(extraction)
      setPending(all.filter((s) => !isDismissed(s, dismissed)))
    })()
  }, [extraction, user])

  const groupedTaste = useMemo(() => {
    const map = new Map<TasteCategory, TasteProfileItem[]>()
    for (const item of taste) {
      const list = map.get(item.category) ?? []
      list.push(item)
      map.set(item.category, list)
    }
    return map
  }, [taste])

  const acceptSuggestion = async (s: Suggestion) => {
    if (!user || !profile) return
    setBusyId(s.id)
    try {
      if (s.type === 'profile_field') {
        await acceptProfileField(s)
      } else if (s.type === 'taste_entry') {
        await acceptTasteEntry(s)
      }
      setPending((prev) => prev.filter((p) => p.id !== s.id))
    } finally {
      setBusyId(null)
    }
  }

  const acceptProfileField = async (s: ProfileFieldSuggestion) => {
    if (!user || !profile) return
    if (s.field === 'strengths' || s.field === 'core_values') {
      const current = (profile[s.field] as unknown[]) ?? []
      const value = String(s.value)
      if (!current.includes(value)) {
        await supabase
          .from('profiles')
          .update({ [s.field]: [...current, value] } as Partial<Profile>)
          .eq('id', user.id)
      }
    } else {
      await supabase
        .from('profiles')
        .update({ [s.field]: s.value } as Partial<Profile>)
        .eq('id', user.id)
    }
    await refresh()
  }

  const acceptTasteEntry = async (s: TasteEntrySuggestion) => {
    if (!user) return
    await supabase.from('taste_profile').insert({
      user_id: user.id,
      category: s.category,
      item: s.item,
      context: s.context,
      source: 'onboarding',
    })
    await loadTaste()
  }

  const rejectSuggestion = async (s: Suggestion) => {
    if (!user) return
    setBusyId(s.id)
    try {
      await dismissSuggestion(user.id, s)
      setPending((prev) => prev.filter((p) => p.id !== s.id))
    } finally {
      setBusyId(null)
    }
  }

  if (!profile) {
    return <div className="flex h-screen items-center justify-center text-reflection-400">Loading…</div>
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-reflection-900">Character Profile</h1>
        <Link to="/" className="text-sm text-reflection-500 hover:text-reflection-700">
          Back
        </Link>
      </div>

      {pending.length > 0 && (
        <div className="mt-6 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">
            Your Reflection noticed a few things
          </p>
          {pending.map((s) => (
            <SuggestionBubble
              key={s.id}
              suggestion={s}
              busy={busyId === s.id}
              onAccept={acceptSuggestion}
              onDismiss={rejectSuggestion}
            />
          ))}
        </div>
      )}

      <section className="mt-8 space-y-4 rounded-xl border border-reflection-200 bg-white p-6">
        <ProfileField
          label="Name"
          value={profile.name}
          emptyHint="Not set yet — tell Your Reflection what to call you."
          onSave={(v) => saveField(user!.id, 'name', v, refresh)}
        />
        <ProfileField
          label="Age"
          value={profile.age != null ? String(profile.age) : null}
          emptyHint="Not set — share it whenever you're comfortable."
          onSave={(v) => saveField(user!.id, 'age', v ? Number(v) : null, refresh)}
        />
        <ProfileField
          label="Class"
          value={profile.class}
          emptyHint="You haven't named your archetype yet — Survivor? Builder? Dreamer? Whatever fits."
          onSave={(v) => saveField(user!.id, 'class', v, refresh)}
        />
        <ProfileField
          label="Personal Philosophy"
          value={profile.philosophy}
          multiline
          emptyHint="Nothing here yet. This fills in as you talk about how you live."
          onSave={(v) => saveField(user!.id, 'philosophy', v, refresh)}
        />
        <ChipList
          label="Unique Strengths & Abilities"
          values={profile.strengths as string[]}
          emptyHint="Nothing yet — these surface as you talk, or add your own below."
          onChange={(v) => saveField(user!.id, 'strengths', v, refresh)}
        />
        <ChipList
          label="Core Values"
          values={profile.core_values as string[]}
          emptyHint="Nothing yet — these surface gradually from journaling and chat."
          onChange={(v) => saveField(user!.id, 'core_values', v, refresh)}
        />
      </section>

      <ConnectedApps />

      <section className="mt-6 rounded-xl border border-reflection-200 bg-white p-6">
        <h2 className="text-sm font-medium text-reflection-900">Taste Profile</h2>
        <p className="mt-1 text-xs text-reflection-500">
          Built from what you share in chat and journaling — add to it any time.
        </p>
        <div className="mt-4 space-y-5">
          {TASTE_CATEGORIES.map(({ key, label, emptyHint }) => (
            <TasteCategorySection
              key={key}
              category={key}
              label={label}
              emptyHint={emptyHint}
              items={groupedTaste.get(key) ?? []}
              onAdded={loadTaste}
            />
          ))}
        </div>
      </section>

      <MemoryControls />
    </div>
  )
}

async function saveField(userId: string, field: string, value: unknown, refresh: () => Promise<void>) {
  await supabase
    .from('profiles')
    .update({ [field]: value } as Partial<Profile>)
    .eq('id', userId)
  await refresh()
}

function ProfileField({
  label,
  value,
  multiline,
  emptyHint,
  onSave,
}: {
  label: string
  value: string | null
  multiline?: boolean
  emptyHint: string
  onSave: (value: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  useEffect(() => setDraft(value ?? ''), [value])

  if (!editing) {
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">{label}</p>
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 text-xs text-reflection-500 hover:text-reflection-700"
          >
            {value ? 'Edit' : 'Add'}
          </button>
        </div>
        {value ? (
          <p className="mt-1 text-sm text-reflection-900">{value}</p>
        ) : (
          <p className="mt-1 text-sm italic text-reflection-400">{emptyHint}</p>
        )}
      </div>
    )
  }

  const Field = multiline ? 'textarea' : 'input'

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">{label}</p>
      <Field
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={multiline ? 3 : undefined}
        className="mt-1 w-full rounded-lg border border-reflection-200 px-2 py-1.5 text-sm outline-none focus:border-reflection-500"
      />
      <div className="mt-1.5 flex gap-2">
        <button
          onClick={() => {
            onSave(draft.trim() || null)
            setEditing(false)
          }}
          className="rounded-md bg-reflection-600 px-2 py-1 text-xs font-medium text-white hover:bg-reflection-700"
        >
          Save
        </button>
        <button
          onClick={() => {
            setDraft(value ?? '')
            setEditing(false)
          }}
          className="rounded-md border border-reflection-200 px-2 py-1 text-xs text-reflection-500"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ChipList({
  label,
  values,
  emptyHint,
  onChange,
}: {
  label: string
  values: string[]
  emptyHint: string
  onChange: (values: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (!v || values.includes(v)) return
    onChange([...values, v])
    setDraft('')
  }

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">{label}</p>
      {values.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full bg-reflection-100 px-2.5 py-1 text-xs text-reflection-700"
            >
              {v}
              <button
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="text-reflection-400 hover:text-reflection-600"
                aria-label={`Remove ${v}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-sm italic text-reflection-400">{emptyHint}</p>
      )}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="Add one…"
          className="flex-1 rounded-lg border border-reflection-200 px-2 py-1.5 text-xs outline-none focus:border-reflection-500"
        />
        <button
          onClick={add}
          className="rounded-md border border-reflection-200 px-2 py-1.5 text-xs text-reflection-500 sm:px-2 sm:py-1"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function TasteCategorySection({
  category,
  label,
  emptyHint,
  items,
  onAdded,
}: {
  category: TasteCategory
  label: string
  emptyHint: string
  items: TasteProfileItem[]
  onAdded: () => void
}) {
  const { user } = useAuth()
  const [item, setItem] = useState('')
  const [context, setContext] = useState('')

  const add = async () => {
    if (!user || !item.trim()) return
    await supabase.from('taste_profile').insert({
      user_id: user.id,
      category,
      item: item.trim(),
      context: context.trim() || null,
      source: 'manual',
    })
    setItem('')
    setContext('')
    onAdded()
  }

  const remove = async (id: string) => {
    await supabase.from('taste_profile').delete().eq('id', id)
    onAdded()
  }

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-reflection-400">{label}</p>
      {items.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {items.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-2 text-sm">
              <div>
                <span className="text-reflection-900">{t.item}</span>
                {t.context && <span className="text-reflection-500"> — {t.context}</span>}
              </div>
              <button
                onClick={() => remove(t.id)}
                className="shrink-0 text-xs text-reflection-400 hover:text-reflection-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm italic text-reflection-400">{emptyHint}</p>
      )}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={item}
          onChange={(e) => setItem(e.target.value)}
          placeholder="Add…"
          className="rounded-lg border border-reflection-200 px-2 py-1.5 text-xs outline-none focus:border-reflection-500 sm:w-32"
        />
        <input
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Why / when (optional)"
          className="flex-1 rounded-lg border border-reflection-200 px-2 py-1.5 text-xs outline-none focus:border-reflection-500"
        />
        <button
          onClick={add}
          className="rounded-md border border-reflection-200 px-2 py-1.5 text-xs text-reflection-500 sm:px-2 sm:py-1"
        >
          Add
        </button>
      </div>
    </div>
  )
}
