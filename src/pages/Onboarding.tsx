import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callApi } from '../lib/api'
import { generateEmbedding } from '../lib/embeddings'
import type { OnboardingExtraction } from '../types/onboarding'

interface VisibleMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ApiMessage {
  role: 'user' | 'assistant'
  content: string
}

const HIDDEN_KICKOFF: ApiMessage = {
  role: 'user',
  content: '(The user just opened the app for the first time. Greet them warmly and start the interview.)',
}

export function Onboarding() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<'welcome' | 'interview' | 'finalizing'>('welcome')
  const [messages, setMessages] = useState<VisibleMessage[]>([])
  const [apiMessages, setApiMessages] = useState<ApiMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToEnd = () => {
    requestAnimationFrame(() => scrollRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }

  const start = async () => {
    setPhase('interview')
    setSending(true)
    setError(null)
    try {
      const { reply } = await callApi<{ reply: string }>('/api/onboarding-chat', {
        messages: [HIDDEN_KICKOFF],
      })
      setApiMessages([HIDDEN_KICKOFF, { role: 'assistant', content: reply }])
      setMessages([{ role: 'assistant', content: reply }])
      scrollToEnd()
    } catch (err) {
      setError(String(err))
    } finally {
      setSending(false)
    }
  }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    setError(null)
    const nextApiMessages = [...apiMessages, { role: 'user' as const, content: text }]
    setApiMessages(nextApiMessages)
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    scrollToEnd()
    try {
      const { reply } = await callApi<{ reply: string }>('/api/onboarding-chat', {
        messages: nextApiMessages,
      })
      setApiMessages((prev) => [...prev, { role: 'assistant', content: reply }])
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
      scrollToEnd()
    } catch (err) {
      setError(String(err))
    } finally {
      setSending(false)
    }
  }

  const finish = async () => {
    if (!user) return
    setPhase('finalizing')
    setError(null)
    try {
      const extraction = await callApi<OnboardingExtraction>('/api/onboarding-finalize', {
        messages: apiMessages,
      })

      // Surface-layer memory scaffolding (PRD 8, Sprint 1): a first
      // pattern_extractions row and an embedded onboarding summary. This
      // happens regardless of which individual suggestion bubbles the
      // user goes on to accept or dismiss on the profile page.
      const tasteContext: Record<string, { item: string; context: string | null }[]> = {}
      for (const t of extraction.taste) {
        tasteContext[t.category] ??= []
        tasteContext[t.category].push({ item: t.item, context: t.context })
      }

      await supabase.from('pattern_extractions').upsert({
        user_id: user.id,
        taste_context: tasteContext,
      })

      if (extraction.summary) {
        const { data: summaryRow } = await supabase
          .from('memory_summaries')
          .insert({
            user_id: user.id,
            tier: 'onboarding',
            period_start: new Date().toISOString(),
            period_end: new Date().toISOString(),
            summary: extraction.summary,
          })
          .select('id')
          .single()

        if (summaryRow) {
          const embedding = await generateEmbedding(extraction.summary)
          if (embedding) {
            await supabase.from('memory_summaries').update({ embedding }).eq('id', summaryRow.id)
          }
        }
      }

      await supabase
        .from('profiles')
        .update({ onboarding_completed_at: new Date().toISOString() })
        .eq('id', user.id)

      navigate('/profile', { state: { extraction } })
    } catch (err) {
      setError(String(err))
      setPhase('interview')
    }
  }

  if (phase === 'welcome') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold text-reflection-900">Your Reflection</h1>
          <p className="mt-3 text-lg text-reflection-700">Let's get to know you.</p>
          <button
            onClick={start}
            disabled={sending}
            className="mt-8 rounded-lg bg-reflection-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-reflection-700 disabled:opacity-50"
          >
            {sending ? 'Starting…' : 'Begin'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-screen max-w-2xl flex-col px-4 py-6">
      <div className="flex-1 space-y-4 overflow-y-auto pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                m.role === 'user'
                  ? 'bg-reflection-600 text-white'
                  : 'bg-white text-reflection-900 border border-reflection-200'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && <p className="text-sm text-reflection-400">Your Reflection is thinking…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div ref={scrollRef} />
      </div>

      <form onSubmit={send} className="flex items-center gap-2 border-t border-reflection-200 pt-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say whatever comes to mind…"
          disabled={sending || phase === 'finalizing'}
          className="flex-1 rounded-lg border border-reflection-200 px-3 py-2 text-sm outline-none focus:border-reflection-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-lg bg-reflection-600 px-3 py-2 text-sm font-medium text-white hover:bg-reflection-700 disabled:opacity-50"
        >
          Send
        </button>
      </form>

      <button
        onClick={finish}
        disabled={messages.length < 2 || phase === 'finalizing'}
        className="mt-3 self-center text-sm text-reflection-500 hover:text-reflection-700 disabled:opacity-40"
      >
        {phase === 'finalizing' ? 'Putting your profile together…' : "I'm ready to see my profile"}
      </button>
    </div>
  )
}
