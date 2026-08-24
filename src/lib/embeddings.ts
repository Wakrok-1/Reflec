import { supabase } from './supabase'

// Calls the embed-text Supabase Edge Function (gte-small, 384 dims).
// Returns null on failure rather than throwing — embeddings are a
// nice-to-have for semantic search, never something that should block the
// user-facing flow that triggered them.
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const { data, error } = await supabase.functions.invoke<{ embedding: number[] }>('embed-text', {
    body: { text },
  })
  if (error || !data?.embedding) {
    console.error('generateEmbedding failed', error)
    return null
  }
  return data.embedding
}
