import { z } from 'zod'

/**
 * Validation for the driver's Reports module.
 *
 * The quick alert is intentionally the loosest schema in this codebase: it is
 * sent in one tap under a 20-second countdown, and every field it might carry is
 * optional. Refusing an emergency signal for a missing field would defeat the
 * feature. The DETAILED form is where the requirements live, and they are
 * enforced in the service rather than here, so the same rule applies to a quick
 * alert later enriched into a detailed one.
 */

const blowbagetsItemsSchema = z.object({
  battery: z.boolean(),
  lights:  z.boolean(),
  oil:     z.boolean(),
  water:   z.boolean(),
  brakes:  z.boolean(),
  air:     z.boolean(),
  gas:     z.boolean(),
  engine:  z.boolean(),
  tires:   z.boolean(),
  self:    z.boolean(),
})

const incidentTypeSchema = z.enum([
  'accident',
  'vehicle_breakdown',
  'health_emergency',
  'security_threat',
])

// Cloudinary URLs. Capped so a runaway client can't post an unbounded array —
// the form offers a handful of attachments, not a gallery.
const mediaUrls = z.array(z.string().url()).max(10)

export const createDriverReportSchema = z.object({
  booking_id: z.string().uuid().optional().nullable(),
  truck_id:   z.string().uuid().optional().nullable(),
  source:     z.enum(['quick', 'detailed']),

  incident_type: incidentTypeSchema.optional().nullable(),
  // Free text: the sub-type list differs per incident and its last option is
  // literally "Other", so an enum here would be wrong within a week.
  sub_type:    z.string().max(100).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),

  photo_urls: mediaUrls.optional(),
  video_urls: mediaUrls.optional(),

  latitude:   z.number().min(-90).max(90).optional().nullable(),
  longitude:  z.number().min(-180).max(180).optional().nullable(),
  accuracy_m: z.number().min(0).optional().nullable(),
  address:    z.string().max(500).optional().nullable(),

  blowbagets_items:  blowbagetsItemsSchema.optional().nullable(),
  trip_can_continue: z.boolean().optional().nullable(),
})

/** Adding to a report already sent. Every field optional — that is the point. */
export const enrichDriverReportSchema = z.object({
  incident_type:     incidentTypeSchema.optional().nullable(),
  sub_type:          z.string().max(100).optional().nullable(),
  description:       z.string().max(4000).optional().nullable(),
  address:           z.string().max(500).optional().nullable(),
  photo_urls:        mediaUrls.optional(),
  video_urls:        mediaUrls.optional(),
  blowbagets_items:  blowbagetsItemsSchema.optional().nullable(),
  trip_can_continue: z.boolean().optional().nullable(),
})

export const setReportStatusSchema = z.object({
  status:          z.enum(['acknowledged', 'resolved']),
  resolution_note: z.string().max(2000).optional().nullable(),
})
