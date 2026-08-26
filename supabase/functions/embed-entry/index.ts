// Supabase Edge Function — embeds a journal entry, snap, chat message, or
// memory summary via gte-small and stores it on that row's `embedding`
// column (PRD "Sprint 2 — Chat Core", item 5). Async: callers invoke this
// and move on, matching the "nothing runs synchronously" job-queue
// pattern (PRD 7.2).
//
// Deploy: npx supabase functions deploy embed-entry
// Requires a valid Supabase user JWT (default verify_jwt behaviour) and
// writes through that user's own RLS policies — no service-role key.
//
// Request:  POST { userId: string, entryId: string, entryType: 'journal_entries' | 'snaps' | 'chat_history' | 'memory_summaries', content: string }
// Response: { ok: true }

// @ts-ignore Deno global + remote std import, not resolved by the app's Node/tsc setup.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
// @ts-ignore Remote ESM import, resolved by the Deno edge runtime, not the app's Node/tsc setup.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EMBEDDABLE_TABLES = ['journal_entries', 'snaps', 'chat_history', 'memory_summaries'] as const
type EmbeddableTable = (typeof EMBEDDABLE_TABLES)[number]

interface EmbedEntryRequest {
  userId?: unknown
  entryId?: unknown
  entryType?: unknown
  content?: unknown
}

// @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  let body: EmbedEntryRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }

  const { userId, entryId, entryType, content } = body
  if (
    typeof userId !== 'string' ||
    typeof entryId !== 'string' ||
    typeof content !== 'string' ||
    !content.trim() ||
    typeof entryType !== 'string' ||
    !EMBEDDABLE_TABLES.includes(entryType as EmbeddableTable)
  ) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401 })
  }

  try {
    // @ts-ignore Supabase is a global provided by the Edge Function runtime.
    const session = new Supabase.ai.Session('gte-small')
    const embedding = (await session.run(content.slice(0, 8000), {
      mean_pool: true,
      normalize: true,
    })) as number[]

    const supabase = createClient(
      // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
      Deno.env.get('SUPABASE_URL'),
      // @ts-ignore Deno is a global provided by the Supabase Edge Function runtime.
      Deno.env.get('SUPABASE_ANON_KEY'),
      { global: { headers: { Authorization: authHeader } } },
    )

    const { error } = await supabase
      .from(entryType as EmbeddableTable)
      .update({ embedding })
      .eq('id', entryId)
      .eq('user_id', userId)

    if (error) {
      return new Response(JSON.stringify({ error: 'Failed to store embedding', detail: error.message }), {
        status: 500,
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Embedding job failed', detail: String(err) }), {
      status: 500,
    })
  }
})
