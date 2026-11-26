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
  /** % of pick-ups the truck reached by the client's pick-up time. */
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

// On time = the truck reached the pick-up point by the client's pick-up time
// (bookings.pickup_arrived_at, stamped by delay.scheduler since 2026-11-26).
// The planned arrival per drop-off it used to be measured against is gone.

const CACHE_MS = 10 * 60_000
let cached: { at: number; value: PublicMetrics } | null = null
let inFlight: Promise<PublicMetrics> | null = null

function percent(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((part / whole) * 1000) / 10
}

async function compute(): Promise<PublicMetrics> {
  const [stopsRes, bookingsRes, servedRes, pickupRes] = await Promise.all([
    supabase
      .from('booking_trip_stops')
      .select('status')
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
    supabase
      .from('bookings')
      .select('schedule_date, call_time, pickup_arrived_at')
      .not('pickup_arrived_at', 'is', null),
  ])

  if (stopsRes.error)    throw stopsRes.error
  if (bookingsRes.error) throw bookingsRes.error
  if (servedRes.error)   throw servedRes.error
  if (pickupRes.error)   throw pickupRes.error

  const stops     = stopsRes.data ?? []
  const delivered = stops.filter((s) => s.status === 'delivered')
  const failed    = stops.length - delivered.length

  let timed = 0
  let onTime = 0
  for (const b of pickupRes.data ?? []) {
    const day = String(b.schedule_date ?? '').slice(0, 10)
    const hm  = String(b.call_time ?? '').slice(0, 5)
    const due = Date.parse(`${day}T${hm}:00+08:00`)
    const at  = Date.parse(String(b.pickup_arrived_at))
    if (!Number.isFinite(due) || !Number.isFinite(at)) continue
    timed++
    if (at <= due) onTime++
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
