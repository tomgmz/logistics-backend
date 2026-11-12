import { supabase } from '../../lib/supabase.js'
import { computeLegEtas, type EtaStop } from '../maps/eta.service.js'
import { UNLOAD_MINUTES_PER_STOP } from '../maps/planned-eta.service.js'
import { notifyStage } from './notification.service.js'
import { BookingModel } from '../../models/client/booking.model.js'

/**
 * The driver changed the drop-off order ("Go here next") and that moves one of
 * the client's drop-offs 30+ minutes later: tell the client (user 2026-11-13).
 *
 * Both orders are timed the same way, from the truck's last position (or the
 * pickup when there is none): Google's traffic-aware driving time between the
 * stops, plus the planner's unloading allowance at each stop before it. Only the
 * difference matters, so the shared parts (loading, the drive to the first
 * stop's area) cancel out.
 *
 * Runs only on a real order change (the nav screen re-sends the saved order on
 * every load), costs two Routes calls, and never blocks the driver's request.
 * No notice when either route can't be timed (no signal to Google, stops not on
 * the map): the live ETA still moves on the client's map.
 */

export const LATER_NOTICE_MINUTES = 30
const MINUTE_S = 60

/** Arrival offsets (seconds) per destination for one order, or null when Google can't time it. */
async function arrivalOffsets(
  from: { latitude: number; longitude: number },
  stops: EtaStop[],
): Promise<Map<string, number> | null> {
  const legs = await computeLegEtas(from, stops)
  if (!legs || legs.length !== stops.length) return null
  return new Map(legs.map((l, i) => [l.destination_id, l.eta_seconds + i * UNLOAD_MINUTES_PER_STOP * MINUTE_S]))
}

function manilaClock(at: number): string {
  return new Date(at).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })
}

export async function noticeClientOfLaterDropoffs(
  bookingId: string,
  beforeTripStopIds: string[],
  afterTripStopIds: string[],
  reason: string | null = null,
): Promise<void> {
  // Only drop-offs still to be done can move.
  const { data: rows } = await supabase
    .from('booking_trip_stops')
    .select('trip_stop_id, status, booking_destinations ( destination_id, address, latitude, longitude, sequence_order )')
    .in('trip_stop_id', afterTripStopIds)
  const byStop = new Map<string, any>()
  for (const r of rows ?? []) {
    const d = (r as any).booking_destinations
    if ((r as any).status !== 'pending' || !d || d.latitude == null || d.longitude == null) continue
    byStop.set((r as any).trip_stop_id, d)
  }
  const toStops = (ids: string[]): EtaStop[] => ids
    .filter((id) => byStop.has(id))
    .map((id) => {
      const d = byStop.get(id)
      return { destination_id: d.destination_id, latitude: Number(d.latitude), longitude: Number(d.longitude) }
    })
  const before = toStops(beforeTripStopIds)
  const after  = toStops(afterTripStopIds)
  if (after.length < 2) return

  // Where the truck is: its last position on this booking, else the pickup.
  const { data: pos } = await supabase
    .from('driver_locations')
    .select('latitude, longitude')
    .eq('booking_id', bookingId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  let from: { latitude: number; longitude: number } | null =
    pos?.latitude != null && pos?.longitude != null ? { latitude: Number(pos.latitude), longitude: Number(pos.longitude) } : null
  if (!from) {
    const { data: b } = await supabase.from('bookings').select('origin_latitude, origin_longitude').eq('booking_id', bookingId).maybeSingle()
    if (b?.origin_latitude == null || b?.origin_longitude == null) return
    from = { latitude: Number(b.origin_latitude), longitude: Number(b.origin_longitude) }
  }

  const [was, now] = await Promise.all([arrivalOffsets(from, before), arrivalOffsets(from, after)])
  if (!was || !now) return

  const nowMs = Date.now()
  const later: Array<{ label: string; minutes: number; at: number }> = []
  for (const s of after) {
    const a = was.get(s.destination_id)
    const b = now.get(s.destination_id)
    if (a == null || b == null) continue
    const minutes = Math.round((b - a) / MINUTE_S)
    if (minutes < LATER_NOTICE_MINUTES) continue
    const d = [...byStop.values()].find((x) => x.destination_id === s.destination_id)
    later.push({
      label:   `Drop-off ${d?.sequence_order ?? '?'}${d?.address ? ` (${d.address})` : ''}`,
      minutes,
      at:      nowMs + b * 1000,
    })
  }
  if (later.length === 0) return

  const booking = await BookingModel.findById(bookingId)
  if (!booking) return
  void notifyStage('dropoff_order_later', booking, {
    reason: reason ?? undefined,
    dropoffsLater: later
      .map((l) => `${l.label} is now about ${l.minutes} min later, around ${manilaClock(l.at)}`)
      .join('; '),
  })
}
