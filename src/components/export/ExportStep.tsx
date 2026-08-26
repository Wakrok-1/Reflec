import { useState } from 'react'
import { pdf, PDFViewer } from '@react-pdf/renderer'
import { ExportDocument } from './pdf/ExportDocument'
import type { Block, CanvasConfig } from '../../lib/exportBlocks'

interface ExportStepProps {
  config: CanvasConfig
  blocks: Block[]
  onBack: () => void
}

export function ExportStep({ config, blocks, onBack }: ExportStepProps) {
  const [downloading, setDownloading] = useState(false)

  const download = async () => {
    setDownloading(true)
    try {
      const blob = await pdf(<ExportDocument config={config} blocks={blocks} />).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `reflec-journal-${config.startDate}${config.startDate !== config.endDate ? `_${config.endDate}` : ''}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="mt-6">
      <div className="rounded-card border border-hair border-[rgba(180,170,158,0.3)] bg-white p-4 text-xs text-stone">
        <p>
          {config.pageSize} · {config.pageColor} · {config.style} ·{' '}
          {config.startDate === config.endDate ? config.startDate : `${config.startDate} to ${config.endDate}`}
        </p>
      </div>

      <div className="mt-4 h-[70vh] overflow-hidden rounded-card border border-hair border-[rgba(180,170,158,0.3)]">
        <PDFViewer width="100%" height="100%" showToolbar={false}>
          <ExportDocument config={config} blocks={blocks} />
        </PDFViewer>
      </div>

      <div className="mt-6 flex justify-between">
        <button onClick={onBack} className="rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-4 py-2 text-xs text-stone">
          Back to editor
        </button>
        <button
          onClick={download}
          disabled={downloading}
          className="rounded-pill px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--gradient-user-bubble)' }}
        >
          {downloading ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
    </div>
  )
}
