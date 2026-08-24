import type { ReactNode } from 'react'

// Linen background + island nav wrapper used by every page (design spec
// v1.0, section 5.2). Stub for Sprint 2 — currently a pass-through so it's
// safe to use before it's filled in.
interface PageShellProps {
  children: ReactNode
}

export function PageShell({ children }: PageShellProps) {
  return <>{children}</>
}
