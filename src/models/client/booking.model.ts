import { supabase } from '../../lib/supabase.js'
import { pool } from '../../lib/database.js'
import {
  CreateBookingInput,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
  BookingCargoItem,
  AccountingReviewInput,
  GmReviewInput,
  OpsAssignInput,
  FleetApproveInput,
  BlowbagetsCheck,
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

async function updateAccountingStatus(
  bookingId: string,
  input: AccountingReviewInput,
): Promise<BookingWithRelations | null> {
  const { error } = await supabase
    .from('bookings')
    .update({
      accounting_status: input.accounting_status,
      rejection_reason:  input.accounting_status === 'rejected' ? input.rejection_reason : null,
      updated_at:        new Date().toISOString(),
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
  // Reset fleet_status to 'pending' so a re-assignment after a fleet rejection
  // re-enters the fleet review cleanly.
  const { error } = await supabase
    .from('bookings')
    .update({ ops_status: input.ops_status, fleet_status: 'pending', updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

async function updateFleetStatus(
  bookingId: string,
  input: FleetApproveInput,
  check: BlowbagetsCheck | null,
): Promise<BookingWithRelations | null> {
  const payload: Record<string, unknown> =
    input.decision === 'rejected'
      // BLOWBAGETS failed: bounce back to operations for re-assignment. Reset the
      // lifecycle to 'approved' so the booking reappears in the operations queue.
      ? { fleet_status: 'rejected', ops_status: 'pending', status: 'approved', rejection_reason: input.rejection_reason ?? null }
      : { fleet_status: 'approved', rejection_reason: null }

  // Record the inspection snapshot when the fleet manager supplied one (both a
  // pass and a fault-finding rejection are worth preserving).
  if (check) payload.blowbagets_check = check

  const { error } = await supabase
    .from('bookings')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)

  if (error) throw error
  return findById(bookingId)
}

async function remove(bookingId: string): Promise<boolean> {
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
): Promise<BookingDestination> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('booking_destinations')
    .update({
      status,
      delivered_at: status === 'delivered' ? now : null,
      // Only touch the proof when one is supplied — an admin correcting a status
      // shouldn't wipe the driver's photo.
      ...(proofPhotoUrl ? { proof_photo_url: proofPhotoUrl, proof_at: now } : {}),
    })
    .eq('destination_id', destinationId)
    .select()
    .single()

  if (error) throw error
  return data
}

/** Record the driver's proof-of-pickup photo on the booking. */
async function setPickupProof(bookingId: string, proofPhotoUrl: string): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({
      pickup_proof_photo_url: proofPhotoUrl,
      pickup_proof_at:        new Date().toISOString(),
      updated_at:             new Date().toISOString(),
    })
    .eq('booking_id', bookingId)

  if (error) throw error
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
  updateAccountingStatus,
  updateGmStatus,
  updateOpsStatus,
  updateFleetStatus,
  remove,
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