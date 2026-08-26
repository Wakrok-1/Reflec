import { Check } from '@phosphor-icons/react'

// Custom checkbox — checks in sage (#B5C9C1). Used for goal increments and
// bucket list items (design spec v1.1, section 5.5).
interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  'aria-label'?: string
}

export function Checkbox({ checked, onChange, ...rest }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
      style={{
        borderColor: checked ? '#B5C9C1' : 'rgba(58,53,48,0.3)',
        background: checked ? '#B5C9C1' : 'transparent',
      }}
      {...rest}
    >
      {checked && <Check size={11} weight="bold" color="#FAF8F5" />}
    </button>
  )
}
