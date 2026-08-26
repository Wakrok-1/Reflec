import { Medal } from '@phosphor-icons/react'

// Achievement medal — gold gradient circle with a Phosphor Medal icon
// (duotone, #D4AF6A primary / #B8943E secondary). Used both at 64px on the
// Achievements grid and at 42px right after a goal crumbles on the Goals
// page (design spec v1.1, section 5.5).
interface MedalBadgeProps {
  size?: number
  animate?: boolean
}

export function MedalBadge({ size = 64, animate = true }: MedalBadgeProps) {
  const iconSize = Math.round(size / 2)

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full ${animate ? 'medal-appear' : ''}`}
      style={{ width: size, height: size, background: 'var(--gradient-medal)' }}
    >
      <Medal size={iconSize} weight="duotone" color="#D4AF6A" className="medal-icon" />
    </div>
  )
}
