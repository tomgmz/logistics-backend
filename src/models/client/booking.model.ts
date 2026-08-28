import { supabase } from '../../lib/supabase.js'
import type { GeofenceOutcome, StopProofPosition } from '../../lib/stop-geofence.js'
import { pool } from '../../lib/database.js'
import {
  CreateBookingInput,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
  BookingCargoItem,
  GmReviewInput,
  OpsAssignInput,
} from '../../types/client/booking.types.js'

export interface BookingListQuery {
  page:    number
  limit:   number
  status?: string | null
  search?: string | null
}

const BOOKING_WITH_RELATIONS_SELECT = `
  booking_id,
  client_id,
  origin,
  origin_longitude,
  origin_latitude,
  truck_type_needed,
  schedule_date,
  call_time,
  status,
  accounting_status,
  gm_status,
  ops_status,
  fleet_status,
  blowbagets_check,
  rejection_reason,
  cancelled_by,
  cancelled_at,
  reference_number,
  total_cost,
  estimated_delivery,
  required_volume_cbm,
  required_weight_kg,
  required_length_cm,
  stackable_required,
  payment_terms,
  transaction_documents,
  pickup_proof_photo_url,
  pickup_proof_at,
  pickup_proof_latitude,
  pickup_proof_longitude,
  pickup_proof_accuracy_m,
  pickup_proof_distance_m,
  pickup_proof_override_reason,
  created_at,
  updated_at,
  clients (
    client_id,
    company_name,
    billing_address,
    payment_terms,
    users (
      first_name,
      last_name,
      email,
      phone
    )
  ),
  booking_destinations (
    destination_id,
    booking_id,
    delivery_id,
    address,
    sequence_order,
    status,
    delivered_at,
    proof_photo_url,
    proof_at,
    proof_latitude,
    proof_longitude,
    proof_accuracy_m,
    proof_distance_m,
    proof_override_reason,
    notes,
    latitude,
    longitude,
    created_at
  ),
  booking_cargo_items (
    item_id,
    booking_id,
    product_id,
    commodity_id,
    shc_id,
    ashc_id,
    commodity_text,
    product_text,
    shc_text,
    ashc_text,
    quantity,
    weight_kg,
    volume_cbm,
    length_cm,
    width_cm,
    height_cm,
    notes,
    created_at,
    updated_at,
    products ( name, unit ),
    commodities ( name, category ),
    shc:handling_codes!booking_cargo_items_shc_id_fkey ( code, name, type ),
    ashc:handling_codes!booking_cargo_items_ashc_id_fkey ( code, name, type )
  ),
  truck_assignments (
    assignment_id,
    truck_id,
    assigned_at,
    trucks (
      plate_number,
      truck_models ( vehicle_type, name )
    )
  ),
  driver_assignments (
    assignment_id,
    driver_id,
    assigned_at,
    drivers (
      license_number,
      users (
        first_name,
        last_name
      )
    )
  )
`

async function countByStatus(): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; n: string }>(
    `SELECT status::text AS status, COUNT(*)::int AS n FROM bookings GROUP BY status`
  )
  let all = 0
  const out: Record<string, number> = {}
  for (const row of result.rows) {
    const n = parseInt(row.n, 10) || 0
    out[row.status] = n
    all += n
  }
  out.all = all
  return out
}

async function findAllPaginated(q: BookingListQuery): Promise<{ rows: BookingWithRelations[]; total: number }> {
  const page   = Math.max(1, q.page)
  const limit  = Math.min(Math.max(1, q.limit), 100)
  const offset = (page - 1) * limit

  const status = (q.status ?? 'all').trim().toLowerCase()
  const search = (q.search ?? '').trim()

  const params: unknown[] = []
  const where: string[]   = []

  if (status !== 'all') {
    params.push(status)
    where.push(`b.status = $${params.length}`)
  }

  if (search) {
    const esc = `%${search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    params.push(esc)
    const i = params.length
    where.push(`(
      b.origin ILIKE $${i} ESCAPE '\\' OR
      b.truck_type_needed ILIKE $${i} ESCAPE '\\' OR
      b.booking_id::text ILIKE $${i} ESCAPE '\\' OR
      b.reference_number ILIKE $${i} ESCAPE '\\' OR
      COALESCE(c.company_name, '') ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const countResult = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n
     FROM bookings b
     LEFT JOIN clients c ON c.client_id = b.client_id
     ${whereSql}`,
    params,
  )
  const total = parseInt(countResult.rows[0]?.n ?? '0', 10) || 0

  const limitIdx  = params.length + 1
  const offsetIdx = params.length + 2
  const idsResult = await pool.query<{ booking_id: string }>(
    `SELECT b.booking_id
     FROM bookings b
     LEFT JOIN clients c ON c.client_id = b.client_id
     ${whereSql}
     ORDER BY b.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, limit, offset],
  )

  const ids = idsResult.rows.map((r) => r.booking_id)
  if (ids.length === 0) return { rows: [], total }

  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_WITH_RELATIONS_SELECT)
    .in('booking_id', ids)

  if (error) throw error

  const byId = new Map((data ?? []).map((row: any) => [row.booking_id as string, row]))
  const rows = ids.map((id) => byId.get(id)).filter(Boolean) as BookingWithRelations[]

  return { rows, total }
}

async function findAll(): Promise<BookingWithRelations[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_WITH_RELATIONS_SELECT)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as unknown as BookingWithRelations[]
}

async function findById(bookingId: string): Promise<BookingWithRelations | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_WITH_RELATIONS_SELECT)
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as unknown as BookingWithRelations | null
}

async function findByClientId(clientId: string): Promise<BookingWithRelations[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_WITH_RELATIONS_SELECT)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as unknown as BookingWithRelations[]
}

async function findByDriverId(driverId: string): Promise<BookingWithRelations[]> {
  const { data, error } = await supabase
    .from('driver_assignments')
    .select(`
      assignment_id,
      assigned_at,
      bookings (
        ${BOOKING_WITH_RELATIONS_SELECT}
      )
    `)
    .eq('driver_id', driverId)
    .order('assigned_at', { ascending: false })

  if (error) throw error

  return (data ?? [])
    .map((row: any) => row.bookings)
    .filter(Boolean) as BookingWithRelations[]
}

/**
 * Whether the user behind `userId` is the driver assigned to this booking.
 * `driver_assignments.driver_id` points at `drivers`, so the check goes through
 * that table's `user_id` (the id carried in the access token).
 */
async function isDriverAssignedToBooking(bookingId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('driver_assignments')
    .select('assignment_id, drivers!inner ( user_id )')
    .eq('booking_id', bookingId)
    .eq('drivers.user_id', userId)
    .limit(1)

  if (error) throw error
  return (data ?? []).length > 0
}

async function create(input: CreateBookingInput): Promise<BookingWithRelations | null> {
  const { destinations, cargo_items, ...bookingData } = input

  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert(bookingData)
    .select()
    .single()

  if (bookingError) throw bookingError

  if (destinations.length > 0) {
    const destinationRows = destinations.map((d) => ({
      ...d,
      booking_id: booking.booking_id,
    }))
    const { error: destError } = await supabase
      .from('booking_destinations')
      .insert(destinationRows)
    if (destError) throw destError
  }

  if (cargo_items && cargo_items.length > 0) {
    const cargoRows = cargo_items.map((item) => ({
      booking_id:     booking.booking_id,
      commodity_id:   item.commodity_id   ?? null,
      commodity_text: item.commodity_text ?? null,
      product_id:     item.product_id     ?? null,
      product_text:   item.product_text   ?? null,
      shc_id:         item.shc_id         ?? null,
      shc_text:       item.shc_text       ?? null,
      ashc_id:        item.ashc_id        ?? null,
      ashc_text:      item.ashc_text      ?? null,
      quantity:       item.quantity       ?? null,
      weight_kg:      item.weight_kg      ?? null,
      volume_cbm:     item.volume_cbm     ?? null,
      length_cm:      item.length_cm      ?? null,
      width_cm:       item.width_cm       ?? null,
      height_cm:      item.height_cm      ?? null,
      notes:          item.notes          ?? null,
    }))
    const { error: cargoError } = await supabase
      .from('booking_cargo_items')
      .insert(cargoRows)
    if (cargoError) throw cargoError
  }

  return findById(booking.booking_id)
}

async function update(bookingId: string, input: UpdateBookingInput): Promise<BookingWithRelations | null> {
  const { error } = await supabase
    .from('bookings')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

async function updateStatus(bookingId: string, status: string): Promise<BookingWithRelations | null> {
  const { error } = await supabase
    .from('bookings')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

/**
 * Cancel a booking and record WHO decided and why.
 *
 * The admin is a decision-maker in their own right, not a stand-in for the GM —
 * in a small operation they turn a booking down without the GM ever seeing it.
 * So their rejection is stamped on `cancelled_by`/`cancelled_at` rather than on
 * `gm_status`, which would misattribute it to a general manager who never
 * reviewed the booking.
 */
async function cancelBooking(
  bookingId: string,
  opts: { reason?: string | null; cancelledBy?: string | null },
): Promise<BookingWithRelations | null> {
  const { error } = await supabase
    .from('bookings')
    .update({
      status:           'cancelled',
      rejection_reason: opts.reason ?? null,
      cancelled_by:     opts.cancelledBy ?? null,
      cancelled_at:     new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

async function updateGmStatus(
  bookingId: string,
  input: GmReviewInput,
): Promise<BookingWithRelations | null> {
  const { error } = await supabase
    .from('bookings')
    .update({
      gm_status:        input.gm_status,
      rejection_reason: input.gm_status === 'rejected' ? input.rejection_reason : null,
      updated_at:       new Date().toISOString(),
    })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

async function updateOpsStatus(
  bookingId: string,
  input: OpsAssignInput,
): Promise<BookingWithRelations | null> {
  const { error } = await supabase
    .from('bookings')
    .update({ ops_status: input.ops_status, updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

/**
 * Record that a scheduled BLOWBAGETS re-check reminder went out for this booking,
 * so the scheduler never sends the same nudge twice (including across restarts).
 */
async function markFleetRecheckSent(
  bookingId: string,
  window: 'day_before' | 'day_of',
): Promise<void> {
  const column = window === 'day_of' ? 'fleet_recheck_day_of_at' : 'fleet_recheck_day_before_at'
  const { error } = await supabase
    .from('bookings')
    .update({ [column]: new Date().toISOString() })
    .eq('booking_id', bookingId)

  if (error) throw error
}

/**
 * Move the booking's delivery record to the stage the booking just reached.
 *
 * `deliveries.status` is a second copy of where the trip is up to, and only the
 * assignment screen used to write it — so a booking driven to completion from
 * the app left its delivery reading 'pending' forever. That is not cosmetic: the
 * assignment UI reads exactly this column to decide who is still out on a job,
 * so a driver whose delivery never closed silently disappears from the pool.
 *
 * Timestamps are stamped once and never overwritten, so a re-run (or a booking
 * completed twice) keeps the moment it first happened.
 */
async function settleDelivery(
  bookingId: string,
  status: 'in_transit' | 'delivered' | 'failed',
): Promise<void> {
  const now = new Date().toISOString()

  const { data, error: findError } = await supabase
    .from('deliveries')
    .select('delivery_id, pickup_time, delivery_time')
    .eq('booking_id', bookingId)

  if (findError) throw findError
  if (!data || data.length === 0) return

  for (const row of data as any[]) {
    const payload: Record<string, unknown> = { status, updated_at: now }
    if (status === 'in_transit' && !row.pickup_time) payload.pickup_time = now
    if (status === 'delivered'  && !row.delivery_time) payload.delivery_time = now

    const { error } = await supabase
      .from('deliveries')
      .update(payload)
      .eq('delivery_id', row.delivery_id)
    if (error) throw error
  }
}

/**
 * Delete a booking and the delivery record hanging off it.
 *
 * Most children of `bookings` cascade, but `deliveries.booking_id` is ON DELETE
 * NO ACTION, so a crewed booking could not be deleted at all — the foreign key
 * threw first and the caller's crew release never ran, stranding the driver on
 * 'assigned'. The delivery is cleared here, in the order the constraints need:
 * its own nullable references are detached (they outlive the trip — an expense
 * or an emergency alert is a record in its own right and must not be destroyed
 * with it), then the delivery, then the booking.
 */
async function remove(bookingId: string): Promise<boolean> {
  const { data: deliveries, error: findError } = await supabase
    .from('deliveries')
    .select('delivery_id')
    .eq('booking_id', bookingId)

  if (findError) throw findError

  const deliveryIds = (deliveries ?? []).map((row: any) => row.delivery_id)

  if (deliveryIds.length > 0) {
    for (const table of ['expenses', 'emergency_alerts', 'maintenance_requests'] as const) {
      const { error } = await supabase
        .from(table)
        .update({ delivery_id: null })
        .in('delivery_id', deliveryIds)
      if (error) throw error
    }

    const { error: deliveryError } = await supabase
      .from('deliveries')
      .delete()
      .in('delivery_id', deliveryIds)
    if (deliveryError) throw deliveryError
  }

  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('booking_id', bookingId)

  if (error) throw error
  return true
}

async function findDestinationsByBookingId(bookingId: string): Promise<BookingDestination[]> {
  const { data, error } = await supabase
    .from('booking_destinations')
    .select('*')
    .eq('booking_id', bookingId)
    .order('sequence_order', { ascending: true })

  if (error) throw error
  return data ?? []
}

async function updateDestination(
  destinationId: string,
  input: UpdateDestinationInput,
): Promise<BookingDestination> {
  const { data, error } = await supabase
    .from('booking_destinations')
    .update(input)
    .eq('destination_id', destinationId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateDestinationStatus(
  destinationId: string,
  status: string,
  proofPhotoUrl?: string | null,
  position?: StopProofPosition | null,
  fence?: GeofenceOutcome | null,
): Promise<BookingDestination> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('booking_destinations')
    .update({
      status,
      delivered_at: status === 'delivered' ? now : null,
      // Only touch the proof when one is supplied — an admin correcting a status
      // shouldn't wipe the driver's photo, or the position that came with it.
      ...(proofPhotoUrl ? { proof_photo_url: proofPhotoUrl, proof_at: now } : {}),
      ...(proofPhotoUrl ? proofPositionColumns('proof', position, fence) : {}),
    })
    .eq('destination_id', destinationId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** Record the driver's proof-of-pickup photo on the booking. */
async function setPickupProof(
  bookingId: string,
  proofPhotoUrl: string,
  position?: StopProofPosition | null,
  fence?: GeofenceOutcome | null,
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      pickup_proof_photo_url: proofPhotoUrl,
      pickup_proof_at:        new Date().toISOString(),
      updated_at:             new Date().toISOString(),
      ...proofPositionColumns('pickup_proof', position, fence),
    })
    .eq('booking_id', bookingId)

  if (error) throw error
}

/**
 * Where the driver stood when they confirmed a stop, as columns.
 *
 * `bookings` and `booking_destinations` record the same five facts under
 * different prefixes, so the shape is built once here rather than spelled out
 * at each call site and drifting apart.
 */
function proofPositionColumns(
  prefix:   'proof' | 'pickup_proof',
  position?: StopProofPosition | null,
  fence?:    GeofenceOutcome | null,
): Record<string, unknown> {
  return {
    [`${prefix}_latitude`]:        position?.latitude  ?? null,
    [`${prefix}_longitude`]:       position?.longitude ?? null,
    [`${prefix}_accuracy_m`]:      position?.accuracy_m ?? null,
    [`${prefix}_distance_m`]:      fence?.distance_m ?? null,
    [`${prefix}_override_reason`]: fence?.override_reason ?? null,
  }
}

async function removeDestination(destinationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('booking_destinations')
    .delete()
    .eq('destination_id', destinationId)

  if (error) throw error
  return true
}

async function findCargoItemsByBookingId(bookingId: string): Promise<BookingCargoItem[]> {
  const { data, error } = await supabase
    .from('booking_cargo_items')
    .select(`
      *,
      products ( name, unit ),
      commodities ( name, category ),
      shc:handling_codes!booking_cargo_items_shc_id_fkey ( code, name, type ),
      ashc:handling_codes!booking_cargo_items_ashc_id_fkey ( code, name, type )
    `)
    .eq('booking_id', bookingId)

  if (error) throw error
  return data ?? []
}

async function upsertCargoItem(
  bookingId: string,
  item: Partial<BookingCargoItem> & { item_id?: string },
): Promise<BookingCargoItem> {
  const payload = {
    booking_id:     bookingId,
    commodity_id:   item.commodity_id   ?? null,
    commodity_text: item.commodity_text ?? null,
    product_id:     item.product_id     ?? null,
    product_text:   item.product_text   ?? null,
    shc_id:         item.shc_id         ?? null,
    shc_text:       item.shc_text       ?? null,
    ashc_id:        item.ashc_id        ?? null,
    ashc_text:      item.ashc_text      ?? null,
    quantity:       item.quantity       ?? null,
    weight_kg:      item.weight_kg      ?? null,
    volume_cbm:     item.volume_cbm     ?? null,
    length_cm:      item.length_cm      ?? null,
    width_cm:       item.width_cm       ?? null,
    height_cm:      item.height_cm      ?? null,
    notes:          item.notes          ?? null,
    ...(item.item_id ? { item_id: item.item_id } : {}),
  }

  const { data, error } = await supabase
    .from('booking_cargo_items')
    .upsert(payload, { onConflict: 'item_id' })
    .select()
    .single()

  if (error) throw error
  return data
}

async function removeCargoItem(itemId: string): Promise<boolean> {
  const { error } = await supabase
    .from('booking_cargo_items')
    .delete()
    .eq('item_id', itemId)

  if (error) throw error
  return true
}

export const BookingModel = {
  // queries
  findAll,
  findAllPaginated,
  countByStatus,
  findById,
  findByClientId,
  findByDriverId,
  isDriverAssignedToBooking,
  // booking mutations
  create,
  update,
  updateStatus,
  cancelBooking,
  updateGmStatus,
  updateOpsStatus,
  markFleetRecheckSent,
  remove,
  settleDelivery,
  setPickupProof,
  // destination mutations
  findDestinationsByBookingId,
  updateDestination,
  updateDestinationStatus,
  removeDestination,
  // cargo item mutations
  findCargoItemsByBookingId,
  upsertCargoItem,
  removeCargoItem,
}