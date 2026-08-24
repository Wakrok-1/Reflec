// Supabase Edge Function — turns text into a 384-dim embedding using
// Supabase's built-in gte-small model (PRD v1.3 section 4: free, runs
// inside Supabase, no external API call).
//
// Deploy: npx supabase functions deploy embed-text
// Requires no extra secrets — gte-small runs on Supabase's inference
// runtime. The function still requires a valid Supabase user JWT (default
// verify_jwt behaviour), so it can't be called anonymously.
//
// Request:  POST { text: string }
// Response: { embedding: number[] }  (384 numbers, cosine-normalized)

// @ts-expect-error Deno global + remote std import, not resolved by the app's Node/tsc setup.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

interface EmbedRequest {
  text?: unknown
}

// @ts-expect-error Deno is a global provided by the Supabase Edge Function runtime.
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  let body: EmbedRequest
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }

  const text = body.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    return new Response(JSON.stringify({ error: '"text" must be a non-empty string' }), {
      status: 400,
    })
  }

  // Truncate defensively — gte-small has a limited context window and this
  // function is only ever fed short summaries/entries, not raw megabytes.
  const input = text.slice(0, 8000)

  try {
    // @ts-expect-error Supabase is a global provided by the Edge Function runtime.
    const session = new Supabase.ai.Session('gte-small')
    const embedding = (await session.run(input, {
      mean_pool: true,
      normalize: true,
    })) as number[]

    return new Response(JSON.stringify({ embedding }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Embedding generation failed', detail: String(err) }), {
      status: 500,
    })
  }
})
