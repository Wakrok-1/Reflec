import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { PageShell } from '../components/layout/PageShell'
import { BlockEditorStep } from '../components/export/BlockEditorStep'
import { ExportStep } from '../components/export/ExportStep'
import {
  createBlock,
  listDaysInRange,
  PAGE_COLORS,
  type Block,
  type CanvasConfig,
  type ExportStyle,
  type PageColorKey,
  type PageSize,
} from '../lib/exportBlocks'
import { fetchGoalsData, type GoalWithIncrements } from '../lib/goals'

// "Most recently updated" includes increment check-offs, not just edits to
// the goal row itself — checking off a step is the most common way a goal
// actually changes day to day.
function lastActivity(entry: GoalWithIncrements): number {
  const timestamps = [entry.goal.updated_at, ...entry.increments.map((i) => i.updated_at)]
  return Math.max(...timestamps.map((t) => new Date(t).getTime()))
}

function pickFeaturedGoal(bigGoals: GoalWithIncrements[]): GoalWithIncrements | null {
  if (bigGoals.length === 0) return null
  return bigGoals.reduce((latest, entry) => (lastActivity(entry) > lastActivity(latest) ? entry : latest))
}

const today = new Date().toISOString().slice(0, 10)

const PAGE_SIZES: PageSize[] = ['A4', 'A5']
const STYLES: ExportStyle[] = ['minimal', 'editorial']
const COLOR_KEYS: PageColorKey[] = ['cream', 'linen', 'sage', 'dove', 'dark']

export function JournalExport() {
  const { user } = useAuth()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [config, setConfig] = useState<CanvasConfig>({
    pageSize: 'A4',
    pageColor: 'cream',
    style: 'minimal',
    startDate: today,
    endDate: today,
  })
  const [blocks, setBlocks] = useState<Block[]>([])
  const [loading, setLoading] = useState(false)

  const buildDefaultBlocks = async () => {
    if (!user) return
    setLoading(true)
    try {
      const [{ data: journalEntries }, { data: snaps }, { data: privateRows }, { bigGoals }] = await Promise.all([
        supabase
          .from('journal_entries')
          .select('*')
          .eq('user_id', user.id)
          .gte('entry_date', config.startDate)
          .lte('entry_date', config.endDate)
          .order('created_at', { ascending: true }),
        supabase
          .from('snaps')
          .select('*')
          .eq('user_id', user.id)
          .gte('created_at', `${config.startDate}T00:00:00`)
          .lt('created_at', `${config.endDate}T23:59:59.999`)
          .order('created_at', { ascending: true }),
        supabase.from('private_entries').select('entry_id, entry_type').eq('user_id', user.id),
        fetchGoalsData(user.id),
      ])

      const privateJournalIds = new Set(
        (privateRows ?? []).filter((r) => r.entry_type === 'journal').map((r) => r.entry_id),
      )
      const privateSnapIds = new Set((privateRows ?? []).filter((r) => r.entry_type === 'snap').map((r) => r.entry_id))

      const days = listDaysInRange(config.startDate, config.endDate)
      const newBlocks: Block[] = []

      for (const day of days) {
        const dayEntries = (journalEntries ?? []).filter(
          (e) => e.entry_date === day && !privateJournalIds.has(e.id),
        )
        for (const entry of dayEntries) {
          newBlocks.push({ id: `je-${entry.id}`, type: 'journal_entry', day, title: entry.title, text: entry.content })
        }

        const daySnaps = (snaps ?? []).filter(
          (s) => s.created_at.slice(0, 10) === day && !privateSnapIds.has(s.id),
        )
        if (daySnaps.length > 0) {
          newBlocks.push({
            id: `sc-${day}`,
            type: 'snap_collection',
            day,
            snaps: daySnaps.map((s) => s.content),
          })
        }
      }

      const featured = pickFeaturedGoal(bigGoals)
      if (featured) {
        newBlocks.push({
          id: `god-${featured.goal.id}`,
          type: 'goal_of_day',
          day: days[days.length - 1] ?? config.startDate,
          title: featured.goal.title,
          progress: featured.progress,
          goalId: featured.goal.id,
        })
      }

      setBlocks(newBlocks)
      setStep(2)
    } finally {
      setLoading(false)
    }
  }

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="flex items-center justify-between">
          <h1 className="font-poppins text-[15px] font-semibold text-charcoal">Export to PDF</h1>
          <Link to="/journal" className="text-xs text-stone">
            Back to Journal
          </Link>
        </div>
        <p className="mt-1 text-xs text-warm-muted">Step {step} of 3</p>

        {step === 1 && (
          <div className="mt-6 space-y-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone">Page size</p>
              <div className="mt-2 flex gap-2">
                {PAGE_SIZES.map((size) => (
                  <button
                    key={size}
                    onClick={() => setConfig((c) => ({ ...c, pageSize: size }))}
                    className={`rounded-pill border px-4 py-2 text-xs font-medium ${
                      config.pageSize === size
                        ? 'border-transparent text-white'
                        : 'border-hair border-[rgba(180,170,158,0.3)] text-stone'
                    }`}
                    style={config.pageSize === size ? { background: 'var(--gradient-stone)' } : undefined}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone">Page colour</p>
              <div className="mt-2 flex gap-2">
                {COLOR_KEYS.map((key) => (
                  <button
                    key={key}
                    onClick={() => setConfig((c) => ({ ...c, pageColor: key }))}
                    aria-label={key}
                    className={`h-9 w-9 rounded-full border-2 ${
                      config.pageColor === key ? 'border-[#818cf8]' : 'border-transparent'
                    }`}
                    style={{ background: PAGE_COLORS[key] }}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone">Style</p>
              <div className="mt-2 flex gap-2">
                {STYLES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setConfig((c) => ({ ...c, style: s }))}
                    className={`rounded-pill border px-4 py-2 text-xs font-medium capitalize ${
                      config.style === s
                        ? 'border-transparent text-white'
                        : 'border-hair border-[rgba(180,170,158,0.3)] text-stone'
                    }`}
                    style={config.style === s ? { background: 'var(--gradient-stone)' } : undefined}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone">Date range</p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="date"
                  value={config.startDate}
                  max={config.endDate}
                  onChange={(e) => setConfig((c) => ({ ...c, startDate: e.target.value }))}
                  className="rounded-lg border border-hair border-[rgba(180,170,158,0.3)] px-3 py-2 text-xs text-charcoal"
                />
                <span className="text-xs text-warm-muted">to</span>
                <input
                  type="date"
                  value={config.endDate}
                  min={config.startDate}
                  onChange={(e) => setConfig((c) => ({ ...c, endDate: e.target.value }))}
                  className="rounded-lg border border-hair border-[rgba(180,170,158,0.3)] px-3 py-2 text-xs text-charcoal"
                />
              </div>
              <p className="mt-1 text-[11px] text-warm-muted">
                {config.startDate === config.endDate
                  ? 'Single day layout.'
                  : 'Multiple days — timeline layout.'}
              </p>
            </div>

            <button
              onClick={buildDefaultBlocks}
              disabled={loading}
              className="w-full rounded-pill py-2.5 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--gradient-user-bubble)' }}
            >
              {loading ? 'Loading your entries…' : 'Continue'}
            </button>
          </div>
        )}

        {step === 2 && (
          <BlockEditorStep
            config={config}
            blocks={blocks}
            onChangeBlocks={setBlocks}
            onBack={() => setStep(1)}
            onContinue={() => setStep(3)}
            onAddBlock={(type, day) => setBlocks((prev) => [...prev, createBlock(type, day)])}
          />
        )}

        {step === 3 && <ExportStep config={config} blocks={blocks} onBack={() => setStep(2)} />}
      </div>
    </PageShell>
  )
}
