import { createClient } from '@supabase/supabase-js'

// Dedicated service-role client for server-initiated realtime broadcasts.
// Mirrors the inline client used by messaging.service so notifications and chat
// share one broadcast convention.
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/**
 * Server-side broadcast. The server never subscribes to these channels, so the
 * message always went over Supabase's REST endpoint; `send()` did that as an
 * implicit fallback (now deprecated, and it logged a warning on every call).
 * httpSend() says so explicitly. The channel object is removed afterwards, so
 * one per broadcast no longer piles up in this client.
 */
export async function broadcast(channel: string, event: string, payload: unknown): Promise<void> {
  const ch = admin.channel(channel)
  try {
    const res = await ch.httpSend(event, payload ?? {})
    if (!res.success) console.error(`[realtime] ${channel} ${event}: ${res.status} ${res.error}`)
  } finally {
    void admin.removeChannel(ch)
  }
}
