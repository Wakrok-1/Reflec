import { PageShell } from '../components/layout/PageShell'

// Full Journal + Export lands in Sprint 3. This keeps the island nav's
// "journal" tab a real destination instead of a dead link in the meantime.
export function Journal() {
  return (
    <PageShell>
      <div className="mx-auto flex h-screen max-w-2xl flex-col items-center justify-center px-4 text-center">
        <h1 className="font-poppins text-[15px] font-semibold text-charcoal">Journal</h1>
        <p className="mt-2 max-w-xs text-[13px] text-warm-muted">
          Full journal entries, snap-to-journal, and export are coming soon. For now, snaps you
          save from chat are already being kept safe.
        </p>
      </div>
    </PageShell>
  )
}
