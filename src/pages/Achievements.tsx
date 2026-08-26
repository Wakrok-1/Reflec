import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { PageShell } from '../components/layout/PageShell'
import { MedalBadge } from '../components/ui/MedalBadge'
import { Checkbox } from '../components/ui/Checkbox'
import { fetchGoalsData, type GoalWithIncrements } from '../lib/goals'

function formatDate(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function Achievements() {
  const { user } = useAuth()
  const [completed, setCompleted] = useState<GoalWithIncrements[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<GoalWithIncrements | null>(null)

  useEffect(() => {
    if (!user) return
    fetchGoalsData(user.id).then(({ completedGoals }) => {
      setCompleted(completedGoals)
      setLoading(false)
    })
  }, [user])

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="flex items-center justify-between">
          <h1 className="font-poppins text-[15px] font-semibold text-charcoal">Achievements</h1>
          <Link to="/goals" className="text-[12px] font-medium text-stone">
            ← Goals
          </Link>
        </div>

        {loading ? (
          <p className="mt-8 text-[13px] text-warm-muted">Loading…</p>
        ) : completed.length === 0 ? (
          <p className="mt-16 text-center font-poppins text-[13px] font-light italic text-[#9E9080]">
            Your medals will appear here when you complete a goal.
          </p>
        ) : (
          <div className="mt-8 grid grid-cols-3 gap-6 sm:grid-cols-4">
            {completed.map((entry) => (
              <button
                key={entry.goal.id}
                onClick={() => setExpanded(entry)}
                className="flex flex-col items-center gap-2 text-center"
              >
                <MedalBadge size={64} animate />
                <span className="font-poppins text-[11px] font-medium leading-tight text-charcoal">
                  {entry.goal.title}
                </span>
                <span className="text-[10px] text-[#9E9080]">{formatDate(entry.goal.completed_at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/20 px-4 pb-32 sm:items-center sm:pb-4"
          onClick={() => setExpanded(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="slide-up-fade-in w-full max-w-md rounded-card-lg border-hair border-[rgba(180,170,158,0.3)] bg-cream p-5"
          >
            <div className="flex flex-col items-center text-center">
              <MedalBadge size={64} animate={false} />
              <h2 className="mt-3 font-poppins text-[15px] font-semibold text-charcoal">{expanded.goal.title}</h2>
              {expanded.goal.description && (
                <p className="mt-1 text-[12px] text-warm-muted">{expanded.goal.description}</p>
              )}
              <p className="mt-1 text-[10px] text-[#9E9080]">
                Completed {formatDate(expanded.goal.completed_at)}
              </p>
            </div>

            {expanded.increments.length > 0 && (
              <div className="mt-4 space-y-2 border-t border-hair border-[rgba(180,170,158,0.3)] pt-4">
                {expanded.increments.map((inc) => (
                  <div key={inc.id} className="flex items-center gap-2">
                    <Checkbox checked onChange={() => {}} aria-label={inc.title} />
                    <span className="text-[12px] text-charcoal line-through">{inc.title}</span>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setExpanded(null)}
              className="mt-4 w-full rounded-pill border-hair border-[rgba(180,170,158,0.3)] py-2 text-xs font-medium text-stone"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </PageShell>
  )
}
