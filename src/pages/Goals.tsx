import { PageShell } from '../components/layout/PageShell'

// Goals page lands in Sprint 4. This keeps the island nav's "goals" tab a
// real destination instead of a dead link in the meantime.
export function Goals() {
  return (
    <PageShell>
      <div className="mx-auto flex h-screen max-w-2xl flex-col items-center justify-center px-4 text-center">
        <h1 className="font-poppins text-[15px] font-semibold text-charcoal">Goals</h1>
        <p className="mt-2 max-w-xs text-[13px] text-warm-muted">
          Big Life Goals, increments, and your bucket list are coming soon.
        </p>
      </div>
    </PageShell>
  )
}
