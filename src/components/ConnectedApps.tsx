import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarBlank } from '@phosphor-icons/react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callApi } from '../lib/api'
import { pushSupported, subscribeToPush, unsubscribeFromPush } from '../lib/push'
import type { NotificationPrefs } from '../lib/database.types'

const DEFAULT_PREFS: NotificationPrefs = {
  daily_checkin: true,
  goal_reminders: true,
  suggestions: true,
  quiet_hours_start: null,
  quiet_hours_end: null,
}

// "Connected" section on the Character Profile page (design spec v1.1,
// Sprint 5): Google Calendar connect/disconnect + the Notifications
// settings the daily cron and chat's calendar-write both read from.
// Strava is out of scope for this sprint — no card for it here.
export function ConnectedApps() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [googleConnected, setGoogleConnected] = useState(false)
  const [connectingGoogle, setConnectingGoogle] = useState(false)
  const [googleStatusMessage, setGoogleStatusMessage] = useState<string | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS)

  const load = async () => {
    if (!user) return
    const [{ data: connection }, { data: profile }] = await Promise.all([
      supabase.from('google_calendar_connections').select('user_id').eq('user_id', user.id).maybeSingle(),
      supabase.from('profiles').select('push_subscription, notification_prefs').eq('id', user.id).single(),
    ])
    setGoogleConnected(!!connection)
    setPushEnabled(!!profile?.push_subscription)
    setPrefs({ ...DEFAULT_PREFS, ...profile?.notification_prefs })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Picks up ?google=connected|error left by api/auth.ts's Google
  // callback redirect, shows a one-time status line, then cleans the URL.
  useEffect(() => {
    const status = searchParams.get('google')
    if (!status) return
    setGoogleStatusMessage(
      status === 'connected' ? 'Google Calendar connected.' : 'Could not connect Google Calendar — please try again.',
    )
    const next = new URLSearchParams(searchParams)
    next.delete('google')
    setSearchParams(next, { replace: true })
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connectGoogle = async () => {
    setConnectingGoogle(true)
    try {
      const { url } = await callApi<{ url: string }>('/api/auth', { action: 'google-start' })
      window.location.href = url
    } catch {
      setConnectingGoogle(false)
    }
  }

  const disconnectGoogle = async () => {
    if (!user) return
    setGoogleConnected(false)
    await supabase.from('google_calendar_connections').delete().eq('user_id', user.id)
  }

  const togglePush = async () => {
    if (!user) return
    if (pushEnabled) {
      await unsubscribeFromPush(user.id)
      setPushEnabled(false)
    } else {
      setPushEnabled(await subscribeToPush(user.id))
    }
  }

  const savePrefs = async (patch: Partial<NotificationPrefs>) => {
    if (!user) return
    const next = { ...prefs, ...patch }
    setPrefs(next)
    await supabase.from('profiles').update({ notification_prefs: next }).eq('id', user.id)
  }

  return (
    <section className="mt-6 rounded-card border-hair border-[rgba(180,170,158,0.3)] bg-cream p-5">
      <h2 className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-stone">Connected</h2>
      {googleStatusMessage && <p className="mt-2 text-[11px] text-charcoal">{googleStatusMessage}</p>}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: googleConnected ? '#B5C9C1' : 'rgba(180,170,158,0.4)' }}
          />
          <span className="font-poppins text-[12px] font-medium text-charcoal">Google Calendar</span>
        </div>
        {googleConnected ? (
          <button onClick={disconnectGoogle} className="text-[11px] text-stone underline-offset-2 hover:underline">
            Disconnect
          </button>
        ) : (
          <button
            onClick={connectGoogle}
            disabled={connectingGoogle}
            className="flex items-center gap-1.5 rounded-pill border-hair border-[rgba(180,170,158,0.3)] bg-white px-3 py-1.5 font-poppins text-[12px] font-medium text-charcoal disabled:opacity-50"
          >
            <CalendarBlank size={13} />
            {connectingGoogle ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>

      <div className="mt-6 border-t border-hair border-[rgba(180,170,158,0.3)] pt-4">
        <h3 className="font-poppins text-[10px] font-semibold uppercase tracking-wide text-stone">Notifications</h3>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="font-poppins text-[12px] text-charcoal">Push notifications</span>
          <ToggleSwitch checked={pushEnabled} onChange={togglePush} disabled={!pushSupported()} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="font-poppins text-[12px] text-charcoal">Daily check-in</span>
          <ToggleSwitch checked={prefs.daily_checkin ?? true} onChange={(v) => savePrefs({ daily_checkin: v })} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="font-poppins text-[12px] text-charcoal">Goal reminders</span>
          <ToggleSwitch checked={prefs.goal_reminders ?? true} onChange={(v) => savePrefs({ goal_reminders: v })} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="font-poppins text-[12px] text-charcoal">Suggestions ready</span>
          <ToggleSwitch checked={prefs.suggestions ?? true} onChange={(v) => savePrefs({ suggestions: v })} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="font-poppins text-[11px] text-stone">Quiet hours</span>
          <input
            type="time"
            value={prefs.quiet_hours_start ?? ''}
            onChange={(e) => savePrefs({ quiet_hours_start: e.target.value || null })}
            className="rounded-md border-hair border-[rgba(180,170,158,0.3)] bg-white px-2 py-1 text-[11px] text-charcoal"
          />
          <span className="text-[11px] text-warm-muted">to</span>
          <input
            type="time"
            value={prefs.quiet_hours_end ?? ''}
            onChange={(e) => savePrefs({ quiet_hours_end: e.target.value || null })}
            className="rounded-md border-hair border-[rgba(180,170,158,0.3)] bg-white px-2 py-1 text-[11px] text-charcoal"
          />
        </div>
      </div>
    </section>
  )
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40"
      style={{ background: checked ? '#B5C9C1' : 'rgba(180,170,158,0.35)' }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  )
}
