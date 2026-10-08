import { pool } from '../../lib/database.js'
import { stampProofPhoto, type ProofStampData } from '../../lib/proof-stamp.js'
import { logSystemThrottled } from '../../lib/log-system.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { reverseGeocode } from '../maps/routeOptimization.service.js'
import { bookingRef } from '../../lib/booking-ref.js'
import type { DriverActor } from '../client/booking.service.js'

/**
 * Everything the stamp on a proof photo says, gathered server-side.
 *
 * The app sends only what the server cannot know — which stop, when the shutter
 * fired, where the phone was — as plain multipart fields next to the image. The
 * plate, booking number, driver name and street address are all looked up here,
 * so none of what the stamp claims about the job comes from the phone.
 *
 * An app build that predates the stamp sends none of these fields, and neither
 * does the report form (which shares the upload helper). Those photos are
 * stored exactly as before: `stampFieldsFrom` returns null and nothing is drawn.
 */

export interface StampFields {
  stop:       'trip_pickup' | 'trip_stop'
  refId:      string
  takenAt:    Date | null
  latitude:   number | null
  longitude:  number | null
  accuracyM:  number | null
  addedLater: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** The stamp fields from a multipart body, or null when this upload asked for no stamp. */
export function stampFieldsFrom(body: Record<string, unknown> | undefined): StampFields | null {
  if (!body) return null
  const stop  = body.stamp_stop
  const refId = typeof body.stamp_ref === 'string' ? body.stamp_ref : ''
  if ((stop !== 'trip_pickup' && stop !== 'trip_stop') || !UUID.test(refId)) return null

  const lat = num(body.latitude)
  const lng = num(body.longitude)
  const located = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

  const taken = typeof body.taken_at === 'string' ? new Date(body.taken_at) : null

  return {
    stop,
    refId,
    takenAt:    taken && !Number.isNaN(taken.getTime()) ? taken : null,
    latitude:   located ? lat : null,
    longitude:  located ? lng : null,
    accuracyM:  located ? num(body.accuracy_m) : null,
    addedLater: body.added_later === '1' || body.added_later === 'true',
  }
}

// The phone's clock is the driver's to set. A taken-at this far from the
// server's clock is not a delayed upload, it is a wrong clock — print the time
// the server received the photo instead. Under it, the "uploaded" line on the
// stamp shows the gap honestly either way.
const MAX_PAST_MS   = 7 * 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000

interface StopContext {
  booking_id:      string
  reference_number: string | null
  trip_number:     number
  trip_count:      number
  stop_number:     number | null
  stop_count:      number | null
  plate:           string | null
}

async function stopContext(fields: StampFields): Promise<StopContext | null> {
  // Trip counts leave out cancelled runs: "trip 2 of 3" must not count a run
  // that is never going to happen. The plate is the delivery's — the company
  // truck, or the vendor vehicle snapshotted onto it at assignment.
  const result = await pool.query<StopContext>(
    `WITH target AS (
       ${fields.stop === 'trip_pickup'
         ? `SELECT bt.trip_id, bt.booking_id, bt.trip_number, NULL::uuid AS destination_id
              FROM booking_trips bt WHERE bt.trip_id = $1`
         : `SELECT bt.trip_id, bt.booking_id, bt.trip_number, s.destination_id
              FROM booking_trip_stops s JOIN booking_trips bt ON bt.trip_id = s.trip_id
             WHERE s.trip_stop_id = $1`}
     )
     SELECT t.booking_id,
            b.reference_number,
            t.trip_number,
            (SELECT COUNT(*)::int FROM booking_trips x
              WHERE x.booking_id = t.booking_id AND x.status <> 'cancelled')            AS trip_count,
            (SELECT COUNT(*)::int + 1 FROM booking_destinations d, booking_destinations me
              WHERE me.destination_id = t.destination_id
                AND d.booking_id = me.booking_id AND d.sequence_order < me.sequence_order) AS stop_number,
            (SELECT COUNT(*)::int FROM booking_destinations d
              WHERE d.booking_id = t.booking_id)                                         AS stop_count,
            (SELECT CASE WHEN dl.is_vendor_supplied THEN dl.vendor_vehicle_plate ELSE tr.plate_number END
               FROM deliveries dl LEFT JOIN trucks tr ON tr.truck_id = dl.truck_id
              WHERE dl.booking_id = t.booking_id
              ORDER BY dl.created_at DESC LIMIT 1)                                       AS plate
       FROM target t JOIN bookings b ON b.booking_id = t.booking_id`,
    [fields.refId],
  )
  const row = result.rows[0]
  if (!row) return null
  if (fields.stop === 'trip_pickup') row.stop_number = null
  return row
}

async function driverName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const result = await pool.query<{ name: string | null }>(
    `SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM users WHERE user_id = $1`,
    [userId],
  )
  return result.rows[0]?.name ?? null
}

/**
 * What the stamp should print for this upload.
 *
 * Booking details are printed only for a booking the uploader is crewed on —
 * otherwise a driver could learn another job's plate and number by naming its
 * stop id. Time and place are printed regardless; they are the uploader's own.
 */
export async function buildStampData(
  fields: StampFields,
  actor: DriverActor,
  receivedAt: Date,
): Promise<ProofStampData> {
  const [context, name, address] = await Promise.all([
    stopContext(fields).catch(() => null),
    driverName(actor.userId).catch(() => null),
    fields.latitude != null && fields.longitude != null
      ? reverseGeocode(fields.latitude, fields.longitude)
      : Promise.resolve(null),
  ])

  let job: StopContext | null = null
  if (context) {
    const allowed = actor.role === 'admin' ||
      (!!actor.userId && !!(await BookingModel.driverCrewRole(context.booking_id, actor.userId).catch(() => null)))
    if (allowed) job = context
  }

  const drift   = fields.takenAt ? receivedAt.getTime() - fields.takenAt.getTime() : 0
  const takenAt = fields.takenAt && drift <= MAX_PAST_MS && drift >= -MAX_FUTURE_MS ? fields.takenAt : receivedAt

  let stopLabel: string | null = null
  let tripLabel: string | null = null
  if (job) {
    stopLabel = fields.stop === 'trip_pickup'
      ? 'PICKUP'
      : job.stop_count && job.stop_count > 1 && job.stop_number
        ? `DROP-OFF ${job.stop_number} OF ${job.stop_count}`
        : 'DROP-OFF'
    if (job.trip_count > 1) tripLabel = `TRIP ${job.trip_number} OF ${job.trip_count}`
  } else {
    stopLabel = fields.stop === 'trip_pickup' ? 'PICKUP' : 'DROP-OFF'
  }

  return {
    takenAt,
    receivedAt,
    plate:      job?.plate ?? null,
    stopLabel,
    tripLabel,
    address,
    latitude:   fields.latitude,
    longitude:  fields.longitude,
    accuracyM:  fields.accuracyM,
    bookingRef: job ? bookingRef(job) : null,
    driverName: name,
    addedLater: fields.addedLater,
  }
}

/**
 * The bytes to store for this upload: stamped when the app asked for a stamp,
 * the original otherwise.
 *
 * A stamp that fails to render falls back to the original photo. The photo is
 * the proof the stop cannot be confirmed without; losing it over a drawing
 * error would block the delivery, which is far worse than a plain picture.
 */
export async function proofPhotoBytes(
  original: Buffer,
  body: Record<string, unknown> | undefined,
  actor: DriverActor,
): Promise<{ buffer: Buffer; stamped: boolean }> {
  const fields = stampFieldsFrom(body)
  if (!fields) return { buffer: original, stamped: false }

  try {
    const data = await buildStampData(fields, actor, new Date())
    return { buffer: await stampProofPhoto(original, data), stamped: true }
  } catch (err) {
    console.error('[proof-stamp] stamping failed, storing the original', err)
    logSystemThrottled('proof-stamp.render', 60_000, {
      log_level:  'error',
      event_type: 'server_error',
      source:     'proof-stamp.render',
      message:    `Proof photo stamp failed; original stored unstamped: ${(err as Error)?.message ?? String(err)}`,
    })
    return { buffer: original, stamped: false }
  }
}
