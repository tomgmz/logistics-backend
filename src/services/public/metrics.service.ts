import { supabase } from '../../lib/supabase.js'

/**
 * The figures on the landing page's "Metrics" section, computed from the real
 * delivery records instead of the marketing numbers that used to be hard-coded
 * in the frontend.
 *
 * Public, so it returns aggregates only — never a row, a name or an id — and is
 * cached in memory: the landing page is the busiest anonymous page there is,
 * and none of these numbers needs to be fresher than a few minutes.
 *
 * Every rate is null when there is nothing to divide by yet, so the page can
 * show a dash instead of a "0%" that would read as a failure.
 */

export interface PublicMetrics {
  /** % of delivered drop-offs that arrived inside their planned window. */
  onTimeRate:        number | null
  /** % of finished drop-offs that were delivered rather than failed. */
  deliverySuccessRate: number | null
  /** Bookings the company took on — cancelled and rejected ones excluded. */
  shipmentsManaged:  number
  /** Drop-off points actually delivered to. */
  dropOffsDelivered: number
  /** Distinct clients with at least one delivered or completed booking. */
  clientsServed:     number
  generatedAt:       string
}

// Mirrors the frontend's arrival window (src/lib/arrival-window.ts): it opens at
// the planned arrival rounded down to 5 minutes and runs 30 minutes past it.
// Arriving any time up to the end of the window the client was shown is on time.
const WINDOW_MS = 30 * 60_000
const ROUND_MS  = 5 * 60_000

const CACHE_MS = 10 * 60_000
let cached: { at: number; value: PublicMetrics } | null = null
let inFlight: Promise<PublicMetrics> | null = null

function percent(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((part / whole) * 1000) / 10
}

async function compute(): Promise<PublicMetrics> {
  const [stopsRes, bookingsRes, servedRes] = await Promise.all([
    supabase
      .from('booking_trip_stops')
      .select('status, delivered_at, planned_arrival_at')
      .in('status', ['delivered', 'failed']),
    supabase
      .from('bookings')
      .select('booking_id', { count: 'exact', head: true })
      .neq('status', 'cancelled')
      .or('gm_status.is.null,gm_status.neq.rejected'),
    supabase
      .from('bookings')
      .select('client_id')
      .in('status', ['delivered', 'completed']),
  ])

  if (stopsRes.error)    throw stopsRes.error
  if (bookingsRes.error) throw bookingsRes.error
  if (servedRes.error)   throw servedRes.error

  const stops     = stopsRes.data ?? []
  const delivered = stops.filter((s) => s.status === 'delivered')
  const failed    = stops.length - delivered.length

  // Only stops that had a plan can be judged on time; one delivered without a
  // planned arrival is left out rather than counted either way.
  let timed = 0
  let onTime = 0
  for (const s of delivered) {
    if (!s.delivered_at || !s.planned_arrival_at) continue
    const planned = Date.parse(s.planned_arrival_at)
    const actual  = Date.parse(s.delivered_at)
    if (!Number.isFinite(planned) || !Number.isFinite(actual)) continue
    timed++
    const windowEnd = Math.floor(planned / ROUND_MS) * ROUND_MS + WINDOW_MS
    if (actual <= windowEnd) onTime++
  }

  const clients = new Set((servedRes.data ?? []).map((b) => b.client_id).filter(Boolean))

  return {
    onTimeRate:          percent(onTime, timed),
    deliverySuccessRate: percent(delivered.length, delivered.length + failed),
    shipmentsManaged:    bookingsRes.count ?? 0,
    dropOffsDelivered:   delivered.length,
    clientsServed:       clients.size,
    generatedAt:         new Date().toISOString(),
  }
}

export async function getPublicMetrics(): Promise<PublicMetrics> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  // One computation at a time: a burst of visitors on a cold cache shares it.
  inFlight ??= compute()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => { inFlight = null })
  return inFlight
}
