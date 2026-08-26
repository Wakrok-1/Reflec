import type { ReactNode } from 'react'
import { IslandNav } from '../ui/IslandNav'

// Linen background + island nav wrapper used by every page (design spec
// section 5.2). pb-28 keeps content clear of the fixed floating navbar.
interface PageShellProps {
  children: ReactNode
}

export function PageShell({ children }: PageShellProps) {
  return (
    <div className="min-h-screen bg-linen pb-28">
      {children}
      <IslandNav />
    </div>
  )
}
