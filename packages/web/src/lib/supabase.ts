import { createClient, SupabaseClient } from '@supabase/supabase-js'

/**
 * Server-side Supabase client using the service-role key.
 *
 * This key bypasses RLS, so it must NEVER be exposed to the browser.
 * Only import this from server components, route handlers, or server actions.
 */
let cached: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variable.'
    )
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
