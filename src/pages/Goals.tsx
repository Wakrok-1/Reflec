import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Sparkle } from '@phosphor-icons/react'
import { useAuth } from '../contexts/AuthContext'
import { useProfile } from '../hooks/useProfile'
import { supabase } from '../lib/supabase'
import { callApi } from '../lib/api'
import { PageShell } from '../components/layout/PageShell'
import { GoalCard } from '../components/ui/GoalCard'
import { Checkbox } from '../components/ui/Checkbox'
import { InlineEditableText } from '../components/ui/InlineEditableText'
import { SuggestionBubble } from '../components/SuggestionBubble'
import { dismissSuggestion, fetchDismissedFingerprints, isDismissed } from '../lib/suggestions'
import {
  addBucketItem,
  addIncrement,
  createBigGoal,
  fetchGoalsData,
  toggleBucketItem,
  toggleIncrement,
  updateGoalTitle,
  updateIncrementTitle,
  type GoalsData,
} from '../lib/goals'
import type { BucketListSuggestion, GoalSuggestion, Suggestion } from '../types/suggestions'

const EMPTY_DATA: GoalsData = { bigGoals: [], bucketList: [], completedGoals: [] }

export function Goals() {
  const { user } = useAuth()
  const { profile, refresh: refreshProfile } = useProfile()
  const [data, setData] = useState<GoalsData>(EMPTY_DATA)
  const [loading, setLoading] = useState(true)
  const [showAddGoal, setShowAddGoal] = useState(false)
  const [addingBucketItem, setAddingBucketItem] = useState(false)
  const [newBucketText, setNewBucketText] = useState('')
  const [pending, setPending] = useState<Suggestion[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [suggestingGoal, setSuggestingGoal] = useState(false)
  const [suggestingBucket, setSuggestingBucket] = useState(false)

  const load = async () => {
    if (!user) return
    const fresh = await fetchGoalsData(user.id)
    setData(fresh)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const handleToggleIncrement = async (id: string, completed: boolean) => {
    await toggleIncrement(id, completed)
    await load()
  }

  const handleAddIncrement = async (goalId: string, title: string) => {
    if (!user) return
    await addIncrement(user.id, goalId, title)
    await load()
  }

  const handleEditGoalTitle = async (goalId: string, title: string) => {
    await updateGoalTitle(goalId, title)
    await load()
  }

  const handleEditIncrementTitle = async (id: string, title: string) => {
    await updateIncrementTitle(id, title)
    await load()
  }

  const handleToggleBucket = async (id: string, completed: boolean) => {
    await toggleBucketItem(id, completed)
    await load()
  }

  const submitBucketItem = async (e: FormEvent) => {
    e.preventDefault()
    const title = newBucketText.trim()
    if (!user || !title) {
      setAddingBucketItem(false)
      return
    }
    await addBucketItem(user.id, title)
    setNewBucketText('')
    setAddingBucketItem(false)
    await load()
  }

  const handleCreateGoal = async (title: string, description: string | null, increments: string[]) => {
    if (!user) return
    await createBigGoal(user.id, title, description, increments)
    await load()
  }

  const handleSavePhilosophy = async (value: string) => {
    if (!user) return
    await supabase.from('profiles').update({ philosophy: value }).eq('id', user.id)
    await refreshProfile()
  }

  const askForGoalSuggestion = async () => {
    if (!user) return
    setSuggestingGoal(true)
    try {
      const result = await callApi<{ title: string; description: string | null; increments: string[] }>(
        '/api/goals',
        { kind: 'goal' },
      )
      const suggestion: GoalSuggestion = {
        type: 'goal_suggestion',
        id: `goal-sugg-${Date.now()}`,
        title: result.title,
        description: result.description,
        increments: result.increments,
      }
      const dismissed = await fetchDismissedFingerprints(user.id)
      if (!isDismissed(suggestion, dismissed)) setPending((prev) => [...prev, suggestion])
    } catch {
      // AI suggestion is a nice-to-have — a failure here shouldn't block the page.
    } finally {
      setSuggestingGoal(false)
    }
  }

  const askForBucketSuggestion = async () => {
    if (!user) return
    setSuggestingBucket(true)
    try {
      const result = await callApi<{ items: { item: string; context: string | null }[] }>('/api/goals', {
        kind: 'bucket',
      })
      const dismissed = await fetchDismissedFingerprints(user.id)
      const suggestions: BucketListSuggestion[] = result.items
        .map(
          (it, i): BucketListSuggestion => ({
            type: 'bucket_list_suggestion',
            id: `bucket-sugg-${Date.now()}-${i}`,
            item: it.item,
            context: it.context,
          }),
        )
        .filter((s) => !isDismissed(s, dismissed))
      setPending((prev) => [...prev, ...suggestions])
    } catch {
      // AI suggestion is a nice-to-have — a failure here shouldn't block the page.
    } finally {
      setSuggestingBucket(false)
    }
  }

  const acceptSuggestion = async (s: Suggestion) => {
    if (!user || (s.type !== 'goal_suggestion' && s.type !== 'bucket_list_suggestion')) return
    setBusyId(s.id)
    try {
      if (s.type === 'goal_suggestion') {
        await createBigGoal(user.id, s.title, s.description, s.increments)
      } else {
        await addBucketItem(user.id, s.item, s.context)
      }
      await load()
      setPending((prev) => prev.filter((p) => p.id !== s.id))
    } finally {
      setBusyId(null)
    }
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

  const goalSuggestions = pending.filter((s) => s.type === 'goal_suggestion')
  const bucketSuggestions = pending.filter((s) => s.type === 'bucket_list_suggestion')

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="flex items-center justify-between">
          <h1 className="font-poppins text-[15px] font-semibold text-charcoal">Goals</h1>
          <Link to="/achievements" className="text-[12px] font-medium text-stone">
            Achievements →
          </Link>
        </div>

        {/* Section A — Big Life Goals + Increments */}
        <section className="mt-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-poppins text-[13px] font-semibold text-charcoal">Big Life Goals</h2>
            <button
              onClick={askForGoalSuggestion}
              disabled={suggestingGoal}
              className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-stone disabled:opacity-50"
            >
              <Sparkle size={12} weight="fill" />
              {suggestingGoal ? 'Thinking…' : 'Ask Your Reflection'}
            </button>
          </div>

          {goalSuggestions.length > 0 && (
            <div className="mt-3 space-y-2">
              {goalSuggestions.map((s) => (
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

          <div className="mt-4 space-y-3">
            {loading ? (
              <p className="text-[13px] text-warm-muted">Loading…</p>
            ) : data.bigGoals.length === 0 ? (
              <p className="text-[13px] italic text-warm-muted">
                Nothing here yet — tap the + button to set your first goal.
              </p>
            ) : (
              data.bigGoals.map(({ goal, increments, progress }) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  increments={increments}
                  progress={progress}
                  onToggleIncrement={handleToggleIncrement}
                  onAddIncrement={(title) => handleAddIncrement(goal.id, title)}
                  onEditTitle={(title) => handleEditGoalTitle(goal.id, title)}
                  onEditIncrementTitle={handleEditIncrementTitle}
                  onCompleted={load}
                />
              ))
            )}
          </div>
        </section>

        {/* Section B — Bucket List */}
        <section className="mt-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-poppins text-[13px] font-semibold text-charcoal">Bucket List</h2>
            <button
              onClick={askForBucketSuggestion}
              disabled={suggestingBucket}
              className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-stone disabled:opacity-50"
            >
              <Sparkle size={12} weight="fill" />
              {suggestingBucket ? 'Thinking…' : 'Ask Your Reflection'}
            </button>
          </div>

          {bucketSuggestions.length > 0 && (
            <div className="mt-3 space-y-2">
              {bucketSuggestions.map((s) => (
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

          <div className="mt-3 space-y-2">
            {data.bucketList.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2.5 rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-cream px-3 py-2.5"
                style={item.status === 'completed' ? { opacity: 0.5 } : undefined}
              >
                <Checkbox checked={item.status === 'completed'} onChange={(c) => handleToggleBucket(item.id, c)} />
                <span
                  className={`flex-1 text-[12px] text-charcoal ${item.status === 'completed' ? 'line-through' : ''}`}
                >
                  {item.title}
                </span>
              </div>
            ))}

            {addingBucketItem ? (
              <form onSubmit={submitBucketItem} className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newBucketText}
                  onChange={(e) => setNewBucketText(e.target.value)}
                  onBlur={() => {
                    if (!newBucketText.trim()) setAddingBucketItem(false)
                  }}
                  placeholder="A new experience…"
                  className="flex-1 rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white px-3 py-2.5 text-[12px] text-charcoal outline-none placeholder:text-warm-muted"
                />
              </form>
            ) : (
              <button
                onClick={() => setAddingBucketItem(true)}
                className="flex items-center gap-1 py-1 text-[11px] font-medium text-stone"
              >
                <Plus size={12} /> Add
              </button>
            )}
          </div>
        </section>

        {/* Section C — Personal Philosophy */}
        <section className="mt-8 rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-cream p-8 text-center">
          <InlineEditableText
            value={profile?.philosophy ?? ''}
            placeholder="What do you believe in?"
            onSave={handleSavePhilosophy}
            multiline
            className="font-poppins text-[13px] font-light italic text-[#5A4E42]"
            inputClassName="w-full resize-none rounded-md border-hair border-[rgba(180,170,158,0.4)] bg-white/70 p-3 text-center font-poppins text-[13px] font-light italic text-[#5A4E42] outline-none"
          />
        </section>
      </div>

      <button
        onClick={() => setShowAddGoal(true)}
        aria-label="Add new goal"
        className="fixed bottom-28 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full text-white shadow-lg"
        style={{ background: 'var(--gradient-user-bubble)' }}
      >
        <Plus size={20} weight="bold" />
      </button>

      {showAddGoal && <AddGoalModal onClose={() => setShowAddGoal(false)} onCreate={handleCreateGoal} />}
    </PageShell>
  )
}

function AddGoalModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (title: string, description: string | null, increments: string[]) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [increments, setIncrements] = useState<string[]>([''])

  const submit = () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    onCreate(trimmedTitle, description.trim() || null, increments.map((i) => i.trim()).filter(Boolean))
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/20 px-4 pb-32 sm:items-center sm:pb-4">
      <div className="slide-up-fade-in w-full max-w-md rounded-card-lg border-hair border-[rgba(180,170,158,0.3)] bg-cream p-4">
        <h2 className="font-poppins text-[14px] font-semibold text-charcoal">New Big Life Goal</h2>

        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Goal title"
          className="mt-3 w-full rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white px-3 py-2.5 text-[13px] text-charcoal outline-none placeholder:text-warm-muted"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={2}
          className="mt-2 w-full resize-none rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white p-3 text-[13px] text-charcoal outline-none placeholder:text-warm-muted"
        />

        <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-stone">Increments (optional)</p>
        <div className="mt-1.5 space-y-1.5">
          {increments.map((inc, i) => (
            <input
              key={i}
              value={inc}
              onChange={(e) =>
                setIncrements((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))
              }
              placeholder={`Step ${i + 1}`}
              className="w-full rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-white px-3 py-2 text-[12px] text-charcoal outline-none placeholder:text-warm-muted"
            />
          ))}
        </div>
        <button
          onClick={() => setIncrements((prev) => [...prev, ''])}
          className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-stone"
        >
          <Plus size={11} /> Add step
        </button>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-pill px-3 py-1.5 text-xs text-stone">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!title.trim()}
            className="rounded-pill px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--gradient-user-bubble)' }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
