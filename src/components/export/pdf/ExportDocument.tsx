import { Document, Image, Page, Path, Rect, Svg, Text, View, Defs, LinearGradient, Stop } from '@react-pdf/renderer'
import { ensurePoppinsRegistered } from './pdfFonts'
import { listDaysInRange, PAGE_COLORS, type Block, type CanvasConfig } from '../../../lib/exportBlocks'

ensurePoppinsRegistered()

const CONTENT_WIDTH: Record<CanvasConfig['pageSize'], number> = {
  A4: 480,
  A5: 330,
}

function formatDayHeading(day: string) {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// A horizontal gradient bar — react-pdf has no CSS backgroundImage, so the
// design spec's gradient fills (goal progress, timeline dot) are drawn as
// tiny inline SVGs instead.
function GradientBar({ width, height = 2, progress }: { width: number; height?: number; progress: number }) {
  const gradientId = `goal-gradient-${width}-${height}`
  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#818cf8" />
          <Stop offset="1" stopColor="#c084fc" />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} fill="rgba(255,255,255,0.45)" />
      <Rect x={0} y={0} width={(width * Math.max(0, Math.min(100, progress))) / 100} height={height} fill={`url(#${gradientId})`} />
    </Svg>
  )
}

function GradientDot({ size = 10, filled }: { size?: number; filled: boolean }) {
  const gradientId = `dot-gradient-${size}`
  return (
    <Svg width={size} height={size}>
      {filled && (
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#818cf8" />
            <Stop offset="1" stopColor="#c084fc" />
          </LinearGradient>
        </Defs>
      )}
      <Path
        d={`M ${size / 2} 0 A ${size / 2} ${size / 2} 0 1 1 ${size / 2 - 0.01} 0 Z`}
        fill={filled ? `url(#${gradientId})` : '#D4C8B8'}
        stroke={filled ? undefined : '#8A7A6A'}
        strokeWidth={filled ? 0 : 0.5}
      />
    </Svg>
  )
}

function clampWidth(width: number, contentWidth: number) {
  return Math.min(width, contentWidth)
}

function MinimalBlockView({ block, contentWidth }: { block: Block; contentWidth: number }) {
  switch (block.type) {
    case 'quote':
      if (!block.text) return null
      return (
        <View
          style={{
            marginVertical: 10,
            paddingVertical: 8,
            borderTopWidth: 0.5,
            borderBottomWidth: 0.5,
            borderColor: 'rgba(138,122,106,0.2)',
          }}
        >
          <Text style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 11, fontStyle: 'italic', color: '#8A7A6A', textAlign: 'center' }}>
            "{block.text}"
          </Text>
        </View>
      )
    case 'journal_entry':
      return (
        <View style={{ marginVertical: 8 }}>
          {block.title && (
            <Text style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 18, color: '#3A3530', marginBottom: 4 }}>
              {block.title}
            </Text>
          )}
          <Text style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 10, lineHeight: 1.8, color: '#5A4E42' }}>
            {block.text}
          </Text>
        </View>
      )
    case 'snap_collection':
      if (block.snaps.length === 0) return null
      return (
        <View style={{ marginVertical: 8 }}>
          {block.snaps.map((snap, i) => (
            <Text
              key={i}
              style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 10, lineHeight: 1.8, color: '#5A4E42', marginBottom: 3 }}
            >
              · {snap}
            </Text>
          ))}
        </View>
      )
    case 'goal_of_day':
      if (!block.title) return null
      return (
        <View style={{ marginVertical: 8 }}>
          <Text style={{ fontFamily: 'Poppins', fontWeight: 400, fontSize: 10, color: '#3A3530', marginBottom: 4 }}>
            {block.title}
          </Text>
          <GradientBar width={contentWidth} height={2} progress={block.progress} />
        </View>
      )
    case 'journal_prompt':
      if (!block.prompt) return null
      return (
        <View style={{ marginVertical: 8 }}>
          <Text style={{ fontFamily: 'Poppins', fontWeight: 600, fontSize: 8, textTransform: 'uppercase', letterSpacing: 1, color: '#B5C9C1', marginBottom: 4 }}>
            Journal Prompt
          </Text>
          <Text style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 10, color: '#3A3530', marginBottom: 6 }}>
            {block.prompt}
          </Text>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ borderBottomWidth: 0.5, borderBottomColor: '#8A7A6A', borderStyle: 'dotted', marginBottom: 8 }} />
          ))}
        </View>
      )
    case 'photo':
      if (!block.src) return null
      return (
        <View style={{ marginVertical: 10, alignItems: 'center' }}>
          <Image
            src={block.src}
            style={{ width: clampWidth(block.width, contentWidth), borderRadius: 8 }}
          />
        </View>
      )
    case 'mood_indicator':
      return (
        <Text style={{ fontFamily: 'Poppins', fontSize: 12, marginVertical: 6 }}>
          {block.mood} <Text style={{ fontSize: 9, color: '#8A7A6A' }}>{block.label}</Text>
        </Text>
      )
    case 'divider':
      return <View style={{ borderBottomWidth: 0.5, borderBottomColor: 'rgba(138,122,106,0.2)', marginVertical: 10 }} />
  }
}

function EditorialBlockView({ block, contentWidth }: { block: Block; contentWidth: number }) {
  switch (block.type) {
    case 'quote':
      if (!block.text) return null
      return (
        <View
          style={{
            marginVertical: 12,
            paddingVertical: 10,
            borderTopWidth: 1.5,
            borderBottomWidth: 1.5,
            borderColor: '#3A3530',
          }}
        >
          <Text style={{ fontFamily: 'Poppins', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', color: '#3A3530', textAlign: 'center' }}>
            {block.text}
          </Text>
        </View>
      )
    case 'journal_entry':
      return (
        <View style={{ marginVertical: 10 }}>
          {block.title && (
            <Text style={{ fontFamily: 'Poppins', fontWeight: 700, fontSize: 16, textTransform: 'uppercase', color: '#3A3530', marginBottom: 6 }}>
              {block.title}
            </Text>
          )}
          <View style={{ borderLeftWidth: 3, borderLeftColor: '#818cf8', paddingLeft: 10 }}>
            <Text style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 10, lineHeight: 1.8, color: '#5A4E42' }}>
              {block.text}
            </Text>
          </View>
        </View>
      )
    case 'snap_collection':
      if (block.snaps.length === 0) return null
      return (
        <View style={{ marginVertical: 10, borderLeftWidth: 3, borderLeftColor: '#818cf8', paddingLeft: 10 }}>
          {block.snaps.map((snap, i) => (
            <Text
              key={i}
              style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 10, lineHeight: 1.8, color: '#5A4E42', marginBottom: 3 }}
            >
              {snap}
            </Text>
          ))}
        </View>
      )
    case 'goal_of_day':
      if (!block.title) return null
      return (
        <View
          style={{
            marginTop: 14,
            padding: 10,
            backgroundColor: '#3A3530',
          }}
        >
          <Text style={{ fontFamily: 'Poppins', fontWeight: 600, fontSize: 9, color: '#EDE8E1', marginBottom: 5 }}>
            {block.title}
          </Text>
          <GradientBar width={contentWidth - 20} height={3} progress={block.progress} />
        </View>
      )
    case 'journal_prompt':
      if (!block.prompt) return null
      return (
        <View style={{ marginVertical: 10 }}>
          <Text style={{ fontFamily: 'Poppins', fontWeight: 600, fontSize: 8, textTransform: 'uppercase', letterSpacing: 1, color: '#B5C9C1', marginBottom: 4 }}>
            Journal Prompt
          </Text>
          <Text style={{ fontFamily: 'Poppins', fontWeight: 300, fontSize: 10, color: '#3A3530', marginBottom: 6 }}>
            {block.prompt}
          </Text>
        </View>
      )
    case 'photo':
      if (!block.src) return null
      return (
        <View style={{ marginVertical: 10, position: 'relative' }}>
          <Image src={block.src} style={{ width: contentWidth, borderRadius: 0 }} />
          <View style={{ position: 'absolute', bottom: 6, left: 6, backgroundColor: 'rgba(58,53,48,0.75)', paddingVertical: 3, paddingHorizontal: 6 }}>
            <Text style={{ fontFamily: 'Poppins', fontWeight: 600, fontSize: 8, textTransform: 'uppercase', color: '#EDE8E1' }}>
              Photo
            </Text>
          </View>
        </View>
      )
    case 'mood_indicator':
      return (
        <View style={{ flexDirection: 'row', marginVertical: 6 }}>
          <Text
            style={{
              fontFamily: 'Poppins',
              fontWeight: 600,
              fontSize: 8,
              textTransform: 'uppercase',
              color: '#8A7A6A',
              borderWidth: 0.5,
              borderColor: '#8A7A6A',
              borderRadius: 3,
              paddingVertical: 3,
              paddingHorizontal: 6,
            }}
          >
            {block.mood} {block.label}
          </Text>
        </View>
      )
    case 'divider':
      return <View style={{ borderBottomWidth: 0.5, borderBottomColor: 'rgba(138,122,106,0.2)', marginVertical: 10 }} />
  }
}

function DayContent({
  day,
  blocks,
  style,
  contentWidth,
}: {
  day: string
  blocks: Block[]
  style: CanvasConfig['style']
  contentWidth: number
}) {
  const dayBlocks = blocks.filter((b) => b.day === day)
  const Renderer = style === 'editorial' ? EditorialBlockView : MinimalBlockView

  return (
    <View>
      {style === 'minimal' ? (
        <Text
          style={{
            fontFamily: 'Poppins',
            fontWeight: 500,
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: 1,
            color: '#8A7A6A',
            marginBottom: 8,
          }}
        >
          {formatDayHeading(day)}
        </Text>
      ) : (
        <View style={{ backgroundColor: '#3A3530', paddingVertical: 10, paddingHorizontal: 12, marginBottom: 10 }}>
          <Text style={{ fontFamily: 'Poppins', fontWeight: 700, fontSize: 22, color: '#EDE8E1' }}>
            {formatDayHeading(day)}
          </Text>
        </View>
      )}
      {dayBlocks.map((block) => (
        <Renderer key={block.id} block={block} contentWidth={contentWidth} />
      ))}
    </View>
  )
}

function TimelineDay({
  day,
  isCurrent,
  blocks,
  style,
  contentWidth,
}: {
  day: string
  isCurrent: boolean
  blocks: Block[]
  style: CanvasConfig['style']
  contentWidth: number
}) {
  return (
    <View style={{ flexDirection: 'row', marginBottom: 16 }}>
      <View style={{ width: 24, alignItems: 'center' }}>
        <GradientDot filled={isCurrent} />
        <View style={{ flex: 1, width: 1, backgroundColor: 'rgba(138,122,106,0.25)', marginTop: 4 }} />
      </View>
      <View style={{ flex: 1 }}>
        <DayContent day={day} blocks={blocks} style={style} contentWidth={contentWidth - 24} />
      </View>
    </View>
  )
}

interface ExportDocumentProps {
  config: CanvasConfig
  blocks: Block[]
}

export function ExportDocument({ config, blocks }: ExportDocumentProps) {
  const days = listDaysInRange(config.startDate, config.endDate)
  const isMultiDay = days.length > 1
  const contentWidth = CONTENT_WIDTH[config.pageSize]
  const pageBackground = PAGE_COLORS[config.pageColor]
  const today = new Date().toISOString().slice(0, 10)

  return (
    <Document>
      <Page
        size={config.pageSize}
        style={{ backgroundColor: pageBackground, padding: 32, fontFamily: 'Poppins' }}
        wrap
      >
        {isMultiDay
          ? days.map((day) => (
              <TimelineDay
                key={day}
                day={day}
                isCurrent={day === today}
                blocks={blocks}
                style={config.style}
                contentWidth={contentWidth}
              />
            ))
          : days.map((day) => (
              <DayContent key={day} day={day} blocks={blocks} style={config.style} contentWidth={contentWidth} />
            ))}
      </Page>
    </Document>
  )
}
