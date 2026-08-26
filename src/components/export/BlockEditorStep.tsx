import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { callApi } from '../../lib/api'
import {
  BLOCK_LIBRARY,
  nextMood,
  PAGE_COLORS,
  type Block,
  type BlockType,
  type CanvasConfig,
} from '../../lib/exportBlocks'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const listener = () => setIsMobile(mq.matches)
    mq.addEventListener('change', listener)
    return () => mq.removeEventListener('change', listener)
  }, [])
  return isMobile
}

interface BlockEditorStepProps {
  config: CanvasConfig
  blocks: Block[]
  onChangeBlocks: (blocks: Block[]) => void
  onAddBlock: (type: BlockType, day: string) => void
  onBack: () => void
  onContinue: () => void
}

export function BlockEditorStep({
  config,
  blocks,
  onChangeBlocks,
  onAddBlock,
  onBack,
  onContinue,
}: BlockEditorStepProps) {
  const isMobile = useIsMobile()
  const days = Array.from(new Set(blocks.map((b) => b.day))).sort()
  const allDays = days.length > 0 ? days : [config.startDate]
  const [activeDay, setActiveDay] = useState(allDays[0])

  useEffect(() => {
    if (!allDays.includes(activeDay)) setActiveDay(allDays[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const updateBlock = (id: string, patch: Partial<Block>) => {
    onChangeBlocks(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)))
  }
  const removeBlock = (id: string) => {
    onChangeBlocks(blocks.filter((b) => b.id !== id))
  }
  const moveBlock = (day: string, index: number, direction: -1 | 1) => {
    const dayBlocks = blocks.filter((b) => b.day === day)
    const target = index + direction
    if (target < 0 || target >= dayBlocks.length) return
    const reordered = arrayMove(dayBlocks, index, target)
    const otherBlocks = blocks.filter((b) => b.day !== day)
    onChangeBlocks(mergeByOriginalOrder(blocks, day, reordered, otherBlocks))
  }

  const handleDragEnd = (day: string) => (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const dayBlocks = blocks.filter((b) => b.day === day)
    const oldIndex = dayBlocks.findIndex((b) => b.id === active.id)
    const newIndex = dayBlocks.findIndex((b) => b.id === over.id)
    const reordered = arrayMove(dayBlocks, oldIndex, newIndex)
    onChangeBlocks(mergeByOriginalOrder(blocks, day, reordered, blocks.filter((b) => b.day !== day)))
  }

  const addFromLibrary = async (type: BlockType) => {
    onAddBlock(type, activeDay)
    if (type === 'journal_prompt') {
      // Fetched right after creation so the block shows a loading state
      // briefly rather than starting blank — see effect below keyed on id.
    }
  }

  return (
    <div className="mt-6">
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-48 lg:shrink-0">
          <p className="text-xs font-medium uppercase tracking-wide text-stone">Add a block</p>
          <div className="mt-2 flex flex-wrap gap-2 lg:flex-col">
            {BLOCK_LIBRARY.map((item) => (
              <button
                key={item.type}
                onClick={() => addFromLibrary(item.type)}
                className="rounded-pill border border-hair border-[rgba(180,170,158,0.3)] bg-white px-3 py-1.5 text-left text-xs text-stone lg:w-full"
              >
                + {item.label}
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {allDays.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {allDays.map((day) => (
                <button
                  key={day}
                  onClick={() => setActiveDay(day)}
                  className={`rounded-pill px-3 py-1 text-xs font-medium ${
                    activeDay === day ? 'text-white' : 'border border-hair border-[rgba(180,170,158,0.3)] text-stone'
                  }`}
                  style={activeDay === day ? { background: 'var(--gradient-stone)' } : undefined}
                >
                  {day}
                </button>
              ))}
            </div>
          )}

          <div
            className="rounded-card-lg border border-hair border-[rgba(180,170,158,0.3)] p-4"
            style={{ background: PAGE_COLORS[config.pageColor] }}
          >
            {allDays
              .filter((day) => day === activeDay || allDays.length === 1)
              .map((day) => {
                const dayBlocks = blocks.filter((b) => b.day === day)
                return (
                  <div key={day} className="space-y-3">
                    {dayBlocks.length === 0 && (
                      <p className="text-xs italic text-warm-muted">
                        Nothing here yet — add a block from the library.
                      </p>
                    )}
                    {isMobile ? (
                      <div className="space-y-3">
                        {dayBlocks.map((block, index) => (
                          <BlockCard
                            key={block.id}
                            block={block}
                            onUpdate={(patch) => updateBlock(block.id, patch)}
                            onRemove={() => removeBlock(block.id)}
                            onMoveUp={index > 0 ? () => moveBlock(day, index, -1) : undefined}
                            onMoveDown={
                              index < dayBlocks.length - 1 ? () => moveBlock(day, index, 1) : undefined
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd(day)}>
                        <SortableContext items={dayBlocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                          <div className="space-y-3">
                            {dayBlocks.map((block, index) => (
                              <SortableBlockCard
                                key={block.id}
                                block={block}
                                onUpdate={(patch) => updateBlock(block.id, patch)}
                                onRemove={() => removeBlock(block.id)}
                                onMoveUp={index > 0 ? () => moveBlock(day, index, -1) : undefined}
                                onMoveDown={
                                  index < dayBlocks.length - 1 ? () => moveBlock(day, index, 1) : undefined
                                }
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-4 py-2 text-xs text-stone">
          Back
        </button>
        <button
          onClick={onContinue}
          className="rounded-pill px-4 py-2 text-xs font-medium text-white"
          style={{ background: 'var(--gradient-user-bubble)' }}
        >
          Continue to export
        </button>
      </div>
    </div>
  )
}

function mergeByOriginalOrder(original: Block[], day: string, reorderedDay: Block[], others: Block[]): Block[] {
  // Reinsert the reordered day's blocks at the position the day's blocks
  // first occupied in the original array, keeping other days untouched.
  const firstIndex = original.findIndex((b) => b.day === day)
  if (firstIndex === -1) return [...others, ...reorderedDay]
  const before = others.filter((_, i) => original.indexOf(others[i]) < firstIndex)
  const after = others.filter((b) => !before.includes(b))
  return [...before, ...reorderedDay, ...after]
}

interface BlockCardProps {
  block: Block
  onUpdate: (patch: Partial<Block>) => void
  onRemove: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  dragHandleProps?: Record<string, unknown>
  setNodeRef?: (el: HTMLElement | null) => void
  style?: CSSProperties
}

function SortableBlockCard(props: Omit<BlockCardProps, 'dragHandleProps' | 'setNodeRef' | 'style'>) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: props.block.id })
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition }
  return (
    <BlockCard {...props} setNodeRef={setNodeRef} style={style} dragHandleProps={{ ...attributes, ...listeners }} />
  )
}

function BlockCard({ block, onUpdate, onRemove, onMoveUp, onMoveDown, dragHandleProps, setNodeRef, style }: BlockCardProps) {
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-card border border-hair border-[rgba(180,170,158,0.3)] bg-white/90 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {dragHandleProps && (
            <span {...dragHandleProps} className="cursor-grab select-none text-warm-muted" aria-label="Drag to reorder">
              ⠿
            </span>
          )}
          <span className="text-[10px] font-medium uppercase tracking-wide text-stone">
            {block.type.replace('_', ' ')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onMoveUp && (
            <button onClick={onMoveUp} aria-label="Move up" className="text-xs text-stone">
              ↑
            </button>
          )}
          {onMoveDown && (
            <button onClick={onMoveDown} aria-label="Move down" className="text-xs text-stone">
              ↓
            </button>
          )}
          <button onClick={onRemove} aria-label="Remove block" className="text-xs text-red-500">
            ✕
          </button>
        </div>
      </div>
      <BlockContent block={block} onUpdate={onUpdate} />
    </div>
  )
}

function EditableText({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <p
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => onChange(e.currentTarget.textContent ?? '')}
      data-placeholder={placeholder}
      className={`empty:before:content-[attr(data-placeholder)] empty:before:text-warm-muted outline-none ${className ?? ''}`}
    >
      {value}
    </p>
  )
}

function BlockContent({ block, onUpdate }: { block: Block; onUpdate: (patch: Partial<Block>) => void }) {
  const promptFetched = useRef(false)

  useEffect(() => {
    if (block.type === 'journal_prompt' && !block.prompt && !promptFetched.current) {
      promptFetched.current = true
      callApi<{ prompt: string }>('/api/journal-prompt', {})
        .then(({ prompt }) => onUpdate({ prompt } as Partial<Block>))
        .catch(() => onUpdate({ prompt: 'What has been quietly taking up space in your mind lately?' } as Partial<Block>))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.type])

  switch (block.type) {
    case 'quote':
      return (
        <EditableText
          value={block.text}
          placeholder="Quote of the day…"
          onChange={(text) => onUpdate({ text })}
          className="text-center text-[13px] italic text-stone"
        />
      )
    case 'journal_entry':
      return (
        <>
          <EditableText
            value={block.title ?? ''}
            placeholder="Entry title (optional)"
            onChange={(title) => onUpdate({ title: title || null })}
            className="mb-1 font-medium text-charcoal"
          />
          <EditableText
            value={block.text}
            placeholder="Entry text…"
            onChange={(text) => onUpdate({ text })}
            className="text-[13px] leading-[1.7] text-charcoal"
          />
        </>
      )
    case 'snap_collection':
      return (
        <ul className="space-y-1">
          {block.snaps.map((snap, i) => (
            <li key={i}>
              <EditableText
                value={snap}
                placeholder="Snap…"
                onChange={(text) => {
                  const next = [...block.snaps]
                  next[i] = text
                  onUpdate({ snaps: next })
                }}
                className="text-[13px] text-charcoal"
              />
            </li>
          ))}
          {block.snaps.length === 0 && <p className="text-xs italic text-warm-muted">No snaps that day.</p>}
        </ul>
      )
    case 'goal_of_day':
      return (
        <div>
          <EditableText
            value={block.title}
            placeholder="Goal title…"
            onChange={(title) => onUpdate({ title })}
            className="mb-2 text-[13px] font-medium text-charcoal"
          />
          <input
            type="range"
            min={0}
            max={100}
            value={block.progress}
            onChange={(e) => onUpdate({ progress: Number(e.target.value) } as Partial<Block>)}
            className="w-full"
          />
          <p className="text-[10px] text-warm-muted">{block.progress}% complete</p>
        </div>
      )
    case 'journal_prompt':
      return (
        <div>
          <p className="mb-1 text-[8px] font-semibold uppercase tracking-wide text-sage">AI prompt</p>
          <EditableText
            value={block.prompt}
            placeholder="Generating a prompt…"
            onChange={(prompt) => onUpdate({ prompt })}
            className="text-[13px] italic text-charcoal"
          />
        </div>
      )
    case 'photo':
      return <PhotoBlockEditor src={block.src} width={block.width} height={block.height} onUpdate={onUpdate} />
    case 'mood_indicator':
      return (
        <button
          onClick={() => {
            const next = nextMood(block.mood)
            onUpdate({ mood: next.mood, label: next.label } as Partial<Block>)
          }}
          className="flex items-center gap-2 text-sm"
        >
          <span className="text-xl">{block.mood}</span>
          <span className="text-xs text-stone">{block.label} (tap to change)</span>
        </button>
      )
    case 'divider':
      return <div className="h-px w-full" style={{ background: 'rgba(138,122,106,0.2)' }} />
  }
}

function PhotoBlockEditor({
  src,
  width,
  height,
  onUpdate,
}: {
  src: string
  width: number
  height: number
  onUpdate: (patch: Partial<Block>) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resizing = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)

  const handleFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => onUpdate({ src: reader.result as string } as Partial<Block>)
    reader.readAsDataURL(file)
  }

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    resizing.current = { startX: e.clientX, startY: e.clientY, startW: width, startH: height }
    const onMove = (ev: PointerEvent) => {
      if (!resizing.current) return
      const dx = ev.clientX - resizing.current.startX
      const dy = ev.clientY - resizing.current.startY
      onUpdate({
        width: Math.max(60, resizing.current.startW + dx),
        height: Math.max(60, resizing.current.startH + dy),
      } as Partial<Block>)
    }
    const onUp = () => {
      resizing.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!src) {
    return (
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg border border-dashed border-[rgba(180,170,158,0.4)] px-4 py-6 text-xs text-warm-muted"
        >
          Click to upload a photo
        </button>
      </div>
    )
  }

  return (
    <div className="relative inline-block" style={{ width, height }}>
      <img src={src} alt="" className="h-full w-full rounded-lg object-cover" />
      <div
        onPointerDown={startResize}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl bg-white/80"
      />
    </div>
  )
}
