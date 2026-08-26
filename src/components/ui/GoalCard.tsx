import { useEffect, useState, type FormEvent } from 'react'
import { CaretDown, CaretUp } from '@phosphor-icons/react'
import type { Goal } from '../../lib/database.types'
import { completeBigGoal } from '../../lib/goals'
import { Checkbox } from './Checkbox'
import { InlineEditableText } from './InlineEditableText'

interface GoalCardProps {
  goal: Goal
  increments: Goal[]
  progress: number
  onToggleIncrement: (incrementId: string, completed: boolean) => void
  onAddIncrement: (title: string) => void
  onEditTitle: (title: string) => void
  onEditIncrementTitle: (incrementId: string, title: string) => void
  /** Called once the crumble animation finishes and the goal is marked completed — the parent should drop it from the active list / refetch. */
  onCompleted: () => void
}

const CRUMBLE_MS = 600

// Big Life Goal card — dove gradient background, gradient orb accent,
// progress bar, expandable increment checklist, crumble-on-100% animation
// (design spec v1.1, section 5.5).
export function GoalCard({
  goal,
  increments,
  progress,
  onToggleIncrement,
  onAddIncrement,
  onEditTitle,
  onEditIncrementTitle,
  onCompleted,
}: GoalCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [newIncrement, setNewIncrement] = useState('')
  const [crumbling, setCrumbling] = useState(false)

  useEffect(() => {
    if (crumbling || progress < 100 || increments.length === 0) return
    setCrumbling(true)
    const timer = setTimeout(async () => {
      await completeBigGoal(goal.id)
      onCompleted()
    }, CRUMBLE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, increments.length, crumbling])

  const submitIncrement = (e: FormEvent) => {
    e.preventDefault()
    const title = newIncrement.trim()
    if (!title) return
    onAddIncrement(title)
    setNewIncrement('')
  }

  return (
    <div
      className={`relative overflow-hidden rounded-card p-4 ${crumbling ? 'goal-crumble' : ''}`}
      style={{ background: 'var(--gradient-dove-card)' }}
    >
      <div
        className="pointer-events-none absolute -right-4 -top-4 h-20 w-20 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(129,140,248,0.15), transparent 70%)' }}
      />

      <div className="relative flex items-start justify-between gap-2">
        <div onClick={() => setExpanded((v) => !v)} className="min-w-0 flex-1 cursor-pointer">
          <InlineEditableText
            value={goal.title}
            onSave={onEditTitle}
            className="font-poppins text-[13px] font-semibold text-charcoal"
            inputClassName="w-full rounded-md border border-hair border-[rgba(180,170,158,0.4)] bg-white/70 px-1.5 py-0.5 font-poppins text-[13px] font-semibold text-charcoal outline-none"
          />
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="shrink-0 text-charcoal/50"
        >
          {expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}
        </button>
      </div>

      <div className="relative mt-3 h-[3px] w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.45)' }}>
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${progress}%`, background: 'var(--gradient-goal-progress)' }}
        />
      </div>
      <p className="relative mt-1.5 text-[10px]" style={{ color: 'rgba(58,53,48,0.6)' }}>
        {progress}% · {increments.filter((i) => i.status === 'completed').length}/{increments.length} increments
      </p>

      {expanded && (
        <div className="relative mt-3 space-y-2 border-t border-hair border-[rgba(180,170,158,0.3)] pt-3">
          {increments.map((inc) => (
            <div key={inc.id} className="flex items-center gap-2">
              <Checkbox
                checked={inc.status === 'completed'}
                onChange={(checked) => onToggleIncrement(inc.id, checked)}
              />
              <InlineEditableText
                value={inc.title}
                onSave={(title) => onEditIncrementTitle(inc.id, title)}
                className={`flex-1 text-[12px] ${inc.status === 'completed' ? 'text-warm-muted line-through' : 'text-charcoal'}`}
                inputClassName="flex-1 rounded-md border border-hair border-[rgba(180,170,158,0.4)] bg-white/70 px-1.5 py-0.5 text-[12px] text-charcoal outline-none"
              />
            </div>
          ))}
          <form onSubmit={submitIncrement} className="flex items-center gap-2 pt-1">
            <input
              value={newIncrement}
              onChange={(e) => setNewIncrement(e.target.value)}
              placeholder="Add a step…"
              className="flex-1 rounded-md border border-hair border-[rgba(180,170,158,0.3)] bg-white/60 px-2 py-1 text-[12px] text-charcoal outline-none placeholder:text-warm-muted"
            />
            <button type="submit" className="shrink-0 text-[11px] font-medium text-stone">
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
