import { useEffect, useState, type KeyboardEvent } from 'react'

// Tap-to-edit-inline text used across the Goals page (goal titles,
// increments, Personal Philosophy) and anywhere else a single field needs
// click-to-edit, save-on-blur behaviour without a separate edit mode UI.
interface InlineEditableTextProps {
  value: string
  placeholder?: string
  onSave: (value: string) => void
  className?: string
  inputClassName?: string
  multiline?: boolean
}

export function InlineEditableText({
  value,
  placeholder,
  onSave,
  className,
  inputClassName,
  multiline,
}: InlineEditableTextProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') {
      setDraft(value)
      setEditing(false)
    }
  }

  if (editing) {
    const Field = multiline ? 'textarea' : 'input'
    return (
      <Field
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        rows={multiline ? 3 : undefined}
        className={inputClassName ?? className}
      />
    )
  }

  return (
    <span
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      className={className}
    >
      {value || <span style={{ color: '#9E9080', fontStyle: 'italic' }}>{placeholder}</span>}
    </span>
  )
}
