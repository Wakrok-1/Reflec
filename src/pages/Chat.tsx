import { useEffect, useRef, useState } from 'react'
import { BellSimple, CalendarPlus, MagnifyingGlass } from '@phosphor-icons/react'
import { useAuth } from '../contexts/AuthContext'
import { useProfile } from '../hooks/useProfile'
import { supabase } from '../lib/supabase'
import { callApi } from '../lib/api'
import { pushSupported, subscribeToPush } from '../lib/push'
import { PageShell } from '../components/layout/PageShell'
import { TypewriterQuote } from '../components/ui/TypewriterQuote'
import { ChatBubble } from '../components/ui/ChatBubble'
import { DoveLoader } from '../components/ui/DoveLoader'
import { SnapInput } from '../components/ui/SnapInput'

const NOTIFY_PROMPT_DISMISSED_KEY = 'your-reflection-notify-prompt-dismissed'

interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  feltRight?: boolean
  /** Off-topic bounce shown locally — never sent to the model, never persisted. */
  ephemeral?: boolean
}

interface ClassifyResult {
  intent: 'on_topic' | 'off_topic' | 'search_needed' | 'calendar_event'
  search_query?: string
  off_topic_reason?: string
  event_title?: string
  event_datetime?: string
  event_duration?: number
}

function formatEventTime(iso: string): string {
  const date = new Date(iso)
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return `${dateStr} at ${timeStr}`
}

const FALLBACK_QUOTES = [
  'The wound is the place where the light enters you.',
  'You are not required to set yourself on fire to keep others warm.',
  'Almost everything will work again if you unplug it for a few minutes, including you.',
  'What you seek is seeking you.',
]

function pickQuote() {
  const dayIndex = Math.floor(Date.now() / 86_400_000) % FALLBACK_QUOTES.length
  return FALLBACK_QUOTES[dayIndex]
}

export function Chat() {
  const { user } = useAuth()
  const { profile } = useProfile()
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [showNotifyPrompt, setShowNotifyPrompt] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [waitingForNext, setWaitingForNext] = useState(false)
  const [pendingSearch, setPendingSearch] = useState<{ query: string; userText: string } | null>(null)
  const [pendingEvent, setPendingEvent] = useState<{
    title: string
    datetime: string
    duration?: number
    userText: string
  } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user) return
    supabase
      .from('chat_history')
      .select('id, role, content')
      .eq('user_id', user.id)
      // Most recent 50 first (descending), then reversed below — ordering
      // ascending with a limit here would fetch the OLDEST 50 rows
      // instead, silently excluding every message sent after a user's
      // history passes 50 total rows (which is exactly what a page
      // navigation away from /chat and back was surfacing: the component
      // remounts, refetches, and any new exchange beyond that cutoff
      // just never comes back).
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (data) setMessages(data.reverse().map((m) => ({ id: m.id, role: m.role, content: m.content })))
      })
  }, [user])

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }, [messages])

  useEffect(() => {
    if (!profile || profile.push_subscription || !pushSupported()) return
    if (localStorage.getItem(NOTIFY_PROMPT_DISMISSED_KEY)) return
    setShowNotifyPrompt(true)
  }, [profile])

  const dismissNotifyPrompt = () => {
    localStorage.setItem(NOTIFY_PROMPT_DISMISSED_KEY, '1')
    setShowNotifyPrompt(false)
  }

  const enableNotifications = async () => {
    if (!user) return
    await subscribeToPush(user.id)
    dismissNotifyPrompt()
  }

  const conversationForApi = (extraUser?: string) =>
    messages
      .filter((m) => !m.ephemeral)
      .map((m) => ({ role: m.role, content: m.content }))
      .concat(extraUser ? [{ role: 'user' as const, content: extraUser }] : [])

  // Renders a multi-message response (Conversation Engine, PRD 7.0) as
  // separate bubbles appearing one after another with natural delays,
  // the way a person sends a few texts in a row rather than one block.
  const renderMultiMessages = async (msgs: { text: string; delay: number }[]) => {
    for (const m of msgs) {
      setWaitingForNext(true)
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(m.delay, 0), 4000)))
      setWaitingForNext(false)
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: m.text }])
    }
  }

  const streamChat = async (userText: string, searchContext?: string) => {
    if (!user) return
    setSending(true)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: conversationForApi(userText), userId: user.id, searchContext }),
      })

      // A multi-message reply comes back as one JSON payload instead of a
      // streamed text/plain body — the shape the server chose based on the
      // Conversation Engine's analysis, not something the client asked for.
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !Array.isArray(data?.messages)) {
          throw new Error(data?.error ?? 'Chat request failed')
        }
        await renderMultiMessages(data.messages)
        return
      }

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error ?? 'Chat request failed')
      }

      const assistantId = crypto.randomUUID()
      setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '' }])
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
        )
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: `Something went wrong: ${String(err)}` },
      ])
    } finally {
      setSending(false)
      setWaitingForNext(false)
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending || !user) return
    setInput('')
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }])

    setSending(true)
    let classification: ClassifyResult
    try {
      classification = await callApi<ClassifyResult>('/api/classify-intent', { message: text })
    } catch {
      classification = { intent: 'on_topic' }
    }
    setSending(false)

    if (classification.intent === 'off_topic') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          ephemeral: true,
          content:
            classification.off_topic_reason
              ? "That's not really my world — I'm here for you, not that. What's actually going on today?"
              : "That's not really my world — I'm here for you. What's actually going on today?",
        },
      ])
      return
    }

    if (classification.intent === 'search_needed' && classification.search_query) {
      setPendingSearch({ query: classification.search_query, userText: text })
      return
    }

    if (classification.intent === 'calendar_event' && classification.event_title && classification.event_datetime) {
      setPendingEvent({
        title: classification.event_title,
        datetime: classification.event_datetime,
        duration: classification.event_duration,
        userText: text,
      })
      return
    }

    await streamChat(text)
  }

  const confirmSearch = async () => {
    if (!pendingSearch) return
    const { query, userText } = pendingSearch
    setPendingSearch(null)
    setSending(true)
    try {
      const { summary } = await callApi<{ summary: string }>('/api/search', { query })
      await streamChat(userText, summary)
    } catch {
      await streamChat(userText)
    }
  }

  const skipSearch = async () => {
    if (!pendingSearch) return
    const { userText } = pendingSearch
    setPendingSearch(null)
    await streamChat(userText)
  }

  const confirmEvent = async () => {
    if (!pendingEvent) return
    const { title, datetime, duration, userText } = pendingEvent
    setPendingEvent(null)
    // Calendar confirm/write is a utility exchange, not a moment of
    // conversation — kept ephemeral like the off-topic bounce, never sent
    // to the model, never persisted to chat_history.
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: userText, ephemeral: true }])
    try {
      const { confirmation } = await callApi<{ eventId: string; confirmation: string }>('/api/calendar', {
        action: 'write',
        title,
        datetime,
        duration,
      })
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: confirmation, ephemeral: true },
      ])
    } catch (err) {
      const message = String(err).includes('not connected')
        ? "I couldn't add that — Google Calendar isn't connected yet. You can connect it on your profile page."
        : `I couldn't add that to your calendar: ${String(err)}`
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: message, ephemeral: true }])
    }
  }

  const skipEvent = async () => {
    if (!pendingEvent) return
    const { userText } = pendingEvent
    setPendingEvent(null)
    await streamChat(userText)
  }

  const markFeltRight = async (messageId: string) => {
    if (!user) return
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feltRight: true } : m)))
    await supabase.from('response_signals').insert({ user_id: user.id, felt_right: true })
  }

  return (
    <PageShell>
      <div className="mx-auto flex h-screen max-w-2xl flex-col">
        <TypewriterQuote quote={pickQuote()} />

        {showNotifyPrompt && (
          <div className="slide-up-fade-in mx-4 mt-2 flex items-center justify-between gap-2 rounded-card border border-hair border-[rgba(180,170,158,0.3)] bg-cream px-4 py-3">
            <p className="flex items-center gap-1.5 text-xs text-charcoal">
              <BellSimple size={13} /> Want a gentle nudge when you haven't checked in?
            </p>
            <div className="flex shrink-0 gap-2">
              <button onClick={dismissNotifyPrompt} className="text-xs text-stone">
                Not now
              </button>
              <button
                onClick={enableNotifications}
                className="rounded-pill px-3 py-1 text-xs font-medium text-white"
                style={{ background: 'var(--gradient-user-bubble)' }}
              >
                Enable
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {messages
            .filter((m) => m.content.length > 0)
            .map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <ChatBubble
                  role={m.role}
                  content={m.content}
                  feltRight={m.feltRight}
                  onFeltRight={() => markFeltRight(m.id)}
                />
              </div>
            ))}
          {((sending && messages[messages.length - 1]?.content === '') || waitingForNext) && <DoveLoader />}
          <div ref={scrollRef} />
        </div>

        {pendingEvent && (
          <div className="slide-up-fade-in mx-4 mb-2 flex flex-col gap-2 rounded-card border border-hair border-[rgba(180,170,158,0.3)] bg-cream px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-xs text-charcoal">
              <CalendarPlus size={13} />
              {pendingEvent.title} — {formatEventTime(pendingEvent.datetime)}
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={skipEvent}
                className="rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-3 py-1 text-xs text-stone"
              >
                Skip
              </button>
              <button
                onClick={confirmEvent}
                className="rounded-pill px-3 py-1 text-xs font-medium text-white"
                style={{ background: 'var(--gradient-user-bubble)' }}
              >
                Add to calendar
              </button>
            </div>
          </div>
        )}

        {pendingSearch && (
          <div className="slide-up-fade-in mx-4 mb-2 flex flex-col gap-2 rounded-card border border-hair border-[rgba(180,170,158,0.3)] bg-cream px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-xs text-charcoal">
              <MagnifyingGlass size={13} />"{pendingSearch.query}"
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={skipSearch}
                className="rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-3 py-1 text-xs text-stone"
              >
                Skip
              </button>
              <button
                onClick={confirmSearch}
                className="rounded-pill px-3 py-1 text-xs font-medium text-white"
                style={{ background: 'var(--gradient-user-bubble)' }}
              >
                Search
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 px-4 pb-4">
          <SnapInput />
          <div
            className="flex flex-1 items-center rounded-pill border border-hair border-[rgba(180,170,158,0.3)] px-3 py-2"
            style={{ background: 'rgba(255,255,255,0.7)' }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
              placeholder="say something..."
              disabled={sending}
              className="w-full bg-transparent text-xs text-charcoal outline-none placeholder:text-warm-muted"
            />
          </div>
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="shrink-0 rounded-pill px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--gradient-user-bubble)' }}
          >
            Send
          </button>
        </div>
      </div>
    </PageShell>
  )
}
