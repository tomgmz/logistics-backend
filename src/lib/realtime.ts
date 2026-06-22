import { createClient } from '@supabase/supabase-js'

// Dedicated service-role client for server-initiated realtime broadcasts.
// Mirrors the inline client used by messaging.service so notifications and chat
// share one broadcast convention.
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function broadcast(channel: string, event: string, payload: unknown): Promise<void> {
  await admin.channel(channel).send({ type: 'broadcast', event, payload })
}
