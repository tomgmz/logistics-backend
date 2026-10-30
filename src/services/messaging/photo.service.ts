import sharp from 'sharp'
import { pool } from '../../lib/database.js'
import { putFile, FILE_REF_PREFIX } from '../../lib/storage.js'
import { stampProofPhoto, type ProofStampData } from '../../lib/proof-stamp.js'
import { logSystemThrottled } from '../../lib/log-system.js'
import { bookingRef } from '../../lib/booking-ref.js'
import { reverseGeocode } from '../maps/routeOptimization.service.js'

/**
 * Photos sent in chat (direct and group).
 *
 * The sender picks one of two kinds before sending:
 *   - stamped: the same time-and-place stamp the driver's proof photos carry,
 *     burned in by the server (see lib/proof-stamp.ts), so nobody can edit it;
 *   - plain:   the picture as taken, with nothing drawn on it.
 *
 * Both are re-encoded here. That applies the EXIF rotation and, just as
 * important, drops the EXIF block, which on a phone photo usually holds the
 * GPS position the sender did not choose to share.
 *
 * The kind is recorded in the storage folder (message_photos/stamped or
 * message_photos/plain). Only this server can write there, so a send can tell
 * from the URL alone whether a photo really was stamped.
 */

export const CHAT_PHOTO_MAX_BYTES = 10 * 1024 * 1024
const MAX_EDGE = 2048

export interface ChatPhotoFields {
  stamp:     boolean
  takenAt:   Date | null
  latitude:  number | null
  longitude: number | null
  accuracyM: number | null
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function chatPhotoFieldsFrom(body: Record<string, unknown> | undefined): ChatPhotoFields {
  const b = body ?? {}
  const lat = num(b.latitude)
  const lng = num(b.longitude)
  const located = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  const taken = typeof b.taken_at === 'string' ? new Date(b.taken_at) : null
  return {
    stamp:     b.stamp === '1' || b.stamp === 'true',
    takenAt:   taken && !Number.isNaN(taken.getTime()) ? taken : null,
    latitude:  located ? lat : null,
    longitude: located ? lng : null,
    accuracyM: located ? num(b.accuracy_m) : null,
  }
}

// Same tolerance as the proof photos: a taken-at this far from the server's
// clock is a wrong phone clock, not a slow upload.
const MAX_PAST_MS   = 7 * 24 * 60 * 60 * 1000
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000

interface SenderContext {
  name:             string | null
  role:             string
  booking_id:       string | null
  reference_number: string | null
  plate:            string | null
}

/**
 * Who is sending, and — for a driver — the delivery they are on now (one in
 * transit before one only assigned), so the stamp shows the truck's plate and
 * booking number like a proof photo does. Nobody else gets job details.
 */
async function senderContext(userId: string): Promise<SenderContext | null> {
  const result = await pool.query<SenderContext>(
    `SELECT NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name,
            u.role,
            job.booking_id, job.reference_number, job.plate
       FROM users u
       LEFT JOIN LATERAL (
         SELECT b.booking_id, b.reference_number,
                (SELECT CASE WHEN dl.is_vendor_supplied THEN dl.vendor_vehicle_plate ELSE tr.plate_number END
                   FROM deliveries dl LEFT JOIN trucks tr ON tr.truck_id = dl.truck_id
                  WHERE dl.booking_id = b.booking_id
                  ORDER BY dl.created_at DESC LIMIT 1) AS plate
           FROM driver_assignments da
           JOIN drivers d  ON d.driver_id = da.driver_id
           JOIN bookings b ON b.booking_id = da.booking_id
          WHERE u.role = 'driver'
            AND d.user_id = u.user_id
            AND b.status IN ('in_transit', 'assigned')
          ORDER BY (b.status = 'in_transit') DESC, b.updated_at DESC
          LIMIT 1
       ) job ON true
      WHERE u.user_id = $1`,
    [userId],
  )
  return result.rows[0] ?? null
}

async function buildChatStampData(fields: ChatPhotoFields, userId: string, receivedAt: Date): Promise<ProofStampData> {
  const [sender, address] = await Promise.all([
    senderContext(userId).catch(() => null),
    fields.latitude != null && fields.longitude != null
      ? reverseGeocode(fields.latitude, fields.longitude)
      : Promise.resolve(null),
  ])

  const drift   = fields.takenAt ? receivedAt.getTime() - fields.takenAt.getTime() : 0
  const takenAt = fields.takenAt && drift <= MAX_PAST_MS && drift >= -MAX_FUTURE_MS ? fields.takenAt : receivedAt
  const isDriver = sender?.role === 'driver'

  return {
    takenAt,
    receivedAt,
    plate:      isDriver ? sender?.plate ?? null : null,
    stopLabel:  'PHOTO',
    tripLabel:  null,
    address,
    latitude:   fields.latitude,
    longitude:  fields.longitude,
    accuracyM:  fields.accuracyM,
    bookingRef: isDriver && sender?.booking_id ? bookingRef(sender) : null,
    driverName: sender?.name ?? null,
    nameLabel:  isDriver ? 'Driver' : 'Sent by',
  }
}

/** Rotated upright, capped in size, EXIF dropped — the "no stamp" photo. */
async function plainBytes(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer()
}

/**
 * Stamp (when asked) and store a chat photo. A stamp that fails to render falls
 * back to the plain photo and says so (`stamped: false`), so the sender is not
 * left with nothing; the app tells them the stamp could not be added.
 */
export async function uploadChatPhoto(
  original: Buffer,
  body: Record<string, unknown> | undefined,
  userId: string,
): Promise<{ url: string; stamped: boolean }> {
  const fields = chatPhotoFieldsFrom(body)

  let buffer: Buffer | null = null
  let stamped = false
  if (fields.stamp) {
    try {
      buffer  = await stampProofPhoto(original, await buildChatStampData(fields, userId, new Date()))
      stamped = true
    } catch (err) {
      console.error('[chat-photo] stamping failed, storing it plain', err)
      logSystemThrottled('chat-photo.stamp', 60_000, {
        log_level:  'error',
        event_type: 'server_error',
        source:     'chat-photo.stamp',
        message:    `Chat photo stamp failed; stored without it: ${(err as Error)?.message ?? String(err)}`,
      })
    }
  }
  if (!buffer) {
    try {
      buffer = await plainBytes(original)
    } catch {
      throw Object.assign(new Error('That file could not be read as a photo'), { statusCode: 400 })
    }
  }

  const { ref } = await putFile(buffer, { folder: `message_photos/${stamped ? 'stamped' : 'plain'}`, ext: 'jpg' })

  return { url: ref, stamped }
}

/**
 * Whether `url` is a chat photo this server stored, and whether it is the
 * stamped kind. Sends accept no other image URL, so a message cannot point at
 * an arbitrary site or pass a plain photo off as stamped.
 */
export function parseChatPhotoUrl(url: string): { stamped: boolean } | null {
  const m = /^message_photos\/(stamped|plain)\/[0-9a-f-]{36}\.(?:jpe?g|png|webp)$/.exec(
    url.startsWith(FILE_REF_PREFIX) ? url.slice(FILE_REF_PREFIX.length) : '',
  )
  return m ? { stamped: m[1] === 'stamped' } : null
}

/** The columns a new message row gets for its text and (optional) photo. */
export interface MessageBodyColumns {
  content:            string
  message_type:       'text' | 'image'
  attachment_url:     string | null
  attachment_stamped: boolean
}

export function messageBodyColumns(content: string, attachmentUrl: string | undefined, placeholder: string): MessageBodyColumns {
  if (!attachmentUrl) return { content, message_type: 'text', attachment_url: null, attachment_stamped: false }
  const photo = parseChatPhotoUrl(attachmentUrl)
  if (!photo) throw Object.assign(new Error('That photo was not uploaded here; add it again'), { statusCode: 400 })
  return {
    content:            content || placeholder,
    message_type:       'image',
    attachment_url:     attachmentUrl,
    attachment_stamped: photo.stamped,
  }
}
