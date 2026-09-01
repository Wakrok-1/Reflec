// Supabase Edge Function — the daily notification sweep (moved off
// Vercel Cron onto Supabase pg_cron, which invokes this function on
// schedule; see supabase/migrations/0007_pg_cron_daily_checkin.sql).
// This function decides WHO needs a notification and WHAT it should
// say; actual delivery happens by calling this app's own
// /api/notifications (its trusted, CRON_SECRET-authenticated path — the
// file was api/send-notification.ts before the Vercel Hobby plan's
// 12-function-limit consolidation), which owns the VAPID/web-push
// mechanics — kept in Node rather than duplicated here in Deno.
//
// Deploy: npx supabase functions deploy daily-checkin
// Secrets: npx supabase secrets set GROQ_API_KEY=... APP_URL=https://your-app.vercel.app CRON_SECRET=...
// (CRON_SECRET must be the same value as the Vercel project's CRON_SECRET env var.)
//
// Only this project's own pg_cron job — authenticated with the actual
// service_role key, per the migration — may call this. That's a
// stricter check than Supabase's default verify_jwt gate, which would
// also accept any logged-in app user's own JWT.

// @ts-ignore Deno global + remote std import, not resolved by the app's Node/tsc setup.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
// @ts-ignore Remote ESM import, resolved by the Deno edge runtime, not the app's Node/tsc setup.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'openai/gpt-oss-20b' // fast/cheap — same tier this app uses for its other pre-checks
const OVERDUE_PACE_MULTIPLIER = 1.5
const MIN_COMPLETED_INCREMENTS_FOR_PACE = 2

interface Goal {
  id: string
  parent_goal_id: string | null
  type: string
  status: string
  title: string
  completed_at: string | null
}

interface NotificationPrefs {
  daily_checkin?: boolean
  goal_reminders?: boolean
  quiet_hours_start?: string | null
  quiet_hours_end?: string | null
}

interface Profile {
  id: string
  push_subscription: unknown
  notification_prefs: NotificationPrefs | null
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

// Quiet hours are compared against this function's UTC clock, not the
// user's local time — there's no per-user timezone stored anywhere in
// this schema yet. Documented limitation, not a silent bug.
function inQuietHours(prefs: NotificationPrefs, now: Date): boolean {
  const start = prefs.quiet_hours_start
  const end = prefs.quiet_hours_end
  if (!start || !end) return false

  const [startH, startM] = start.split(':').map(Number)
  const [endH, endM] = end.split(':').map(Number)
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (startMinutes === endMinutes) return false
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes
  return nowMinutes >= startMinutes || nowMinutes < endMinutes // wraps past midnight
}

async function personalize(apiKey: string, instruction: string): Promise<string> {
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 60,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            'You are Your Reflection, a personal AI companion. Write ONE short push-notification line — under 100 characters, warm, specific, never generic ("Time to journal!" is banned). No quotes, no emoji, no sign-off. Just the line.',
        },
        { role: 'user', content: instruction },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Groq request failed: ${response.status} ${await response.text()}`)
  const data = await response.json()
  const text = data?.choices?.[0]?.message?.content
  return typeof text === 'string' ? text.trim().replace(/^"|"$/g, '') : 'How are you doing today?'
}

function computeOverduePace(increments: Goal[]): { overdue: boolean; days: number } | null {
  const completed = increments
    .filter((i) => i.status === 'completed' && i.completed_at)
    .sort((a, b) => new Date(a.completed_at!).getTime() - new Date(b.completed_at!).getTime())
  if (completed.length < MIN_COMPLETED_INCREMENTS_FOR_PACE) return null

  const gaps: number[] = []
  for (let i = 1; i < completed.length; i++) {
    gaps.push(new Date(completed[i].completed_at!).getTime() - new Date(completed[i - 1].completed_at!).getTime())
  }
  const avgGapMs = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const sinceLastMs = Date.now() - new Date(completed[completed.length - 1].completed_at!).getTime()
  return { overdue: sinceLastMs > avgGapMs * OVERDUE_PACE_MULTIPLIER, days: Math.floor(sinceLastMs / 86_400_000) }
}

// @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
Deno.serve(async (req: Request) => {
  // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const authHeader = req.headers.get('Authorization')
  if (!serviceRoleKey || authHeader !== `Bearer ${serviceRoleKey}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
  const groqApiKey = Deno.env.get('GROQ_API_KEY')
  // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
  const appUrl = Deno.env.get('APP_URL')
  // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (!groqApiKey || !appUrl || !cronSecret) {
    return new Response(JSON.stringify({ error: 'Missing GROQ_API_KEY, APP_URL, or CRON_SECRET secret' }), {
      status: 500,
    })
  }

  const supabase = createClient(
    // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
    Deno.env.get('SUPABASE_URL'),
    serviceRoleKey,
  )

  const now = new Date()
  const today = todayUtc()
  let checkInsSent = 0
  let remindersSent = 0

  const alreadySentToday = async (userId: string, type: 'daily_checkin' | 'goal_reminder', refId: string | null) => {
    let query = supabase
      .from('notification_log')
      .select('id')
      .eq('user_id', userId)
      .eq('type', type)
      .gte('sent_at', `${today}T00:00:00Z`)
    if (refId) query = query.eq('ref_id', refId)
    const { data } = await query.limit(1)
    return (data?.length ?? 0) > 0
  }

  // Delivers via this app's own /api/notifications (trusted path) and
  // only logs the send once delivery actually succeeds.
  const send = async (
    userId: string,
    type: 'daily_checkin' | 'goal_reminder',
    refId: string | null,
    title: string,
    body: string,
  ) => {
    const response = await fetch(`${appUrl}/api/notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cronSecret}` },
      body: JSON.stringify({ userId, title, body }),
    })
    const result = await response.json().catch(() => ({}))
    if (result?.sent) {
      await supabase.from('notification_log').insert({ user_id: userId, type, ref_id: refId })
      return true
    }
    return false
  }

  try {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, push_subscription, notification_prefs')
      .not('push_subscription', 'is', null)

    for (const profile of (profiles ?? []) as Profile[]) {
      if (!profile.push_subscription) continue
      const prefs: NotificationPrefs = profile.notification_prefs ?? {}
      if (inQuietHours(prefs, now)) continue

      if (prefs.daily_checkin !== false) {
        const { data: activityToday } = await supabase
          .from('chat_history')
          .select('id')
          .eq('user_id', profile.id)
          .gte('created_at', `${today}T00:00:00Z`)
          .limit(1)
        const hasActivity = (activityToday?.length ?? 0) > 0

        if (!hasActivity && !(await alreadySentToday(profile.id, 'daily_checkin', null))) {
          const [{ data: lastChat }, { data: lastJournal }, { data: lastSnap }] = await Promise.all([
            supabase
              .from('chat_history')
              .select('content, created_at')
              .eq('user_id', profile.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
            supabase
              .from('journal_entries')
              .select('content, created_at')
              .eq('user_id', profile.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
            supabase
              .from('snaps')
              .select('content, created_at')
              .eq('user_id', profile.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
          ])

          const candidates = [lastChat, lastJournal, lastSnap].filter(
            (c): c is { content: string; created_at: string } => !!c,
          )
          let body: string
          if (candidates.length === 0) {
            body = 'Haven’t seen you today — how are you doing?'
          } else {
            candidates.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            const snippet = candidates[0].content.slice(0, 200)
            body = await personalize(
              groqApiKey,
              `The user's most recent entry/message was: "${snippet}"\nWrite a check-in notification that gently references it (without quoting it verbatim) and asks how they're doing today.`,
            )
          }

          if (await send(profile.id, 'daily_checkin', null, 'Your Reflection', body)) checkInsSent += 1
        }
      }

      if (prefs.goal_reminders !== false) {
        const { data: goalRows } = await supabase
          .from('goals')
          .select('*')
          .eq('user_id', profile.id)
          .in('type', ['big_goal', 'increment'])
        const rows = (goalRows ?? []) as Goal[]
        const incrementsByParent = new Map<string, Goal[]>()
        for (const row of rows) {
          if (row.type !== 'increment' || !row.parent_goal_id) continue
          const list = incrementsByParent.get(row.parent_goal_id) ?? []
          list.push(row)
          incrementsByParent.set(row.parent_goal_id, list)
        }

        for (const goal of rows.filter((g) => g.type === 'big_goal' && g.status === 'active')) {
          const increments = incrementsByParent.get(goal.id) ?? []
          const pace = computeOverduePace(increments)
          if (!pace?.overdue) continue
          if (await alreadySentToday(profile.id, 'goal_reminder', goal.id)) continue

          const body = await personalize(
            groqApiKey,
            `The user has a goal called "${goal.title}" and hasn't checked off a step in about ${pace.days} days, which is longer than their own usual pace on this goal. Write a gentle reminder notification about it.`,
          )
          if (await send(profile.id, 'goal_reminder', goal.id, 'Your Reflection', body)) remindersSent += 1
        }
      }
    }

    return new Response(JSON.stringify({ checkInsSent, remindersSent }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'daily-checkin failed', detail: String(err) }), { status: 500 })
  }
})
