import { supabase } from '../../lib/supabase.js'
import { withBookingRowLock } from '../../lib/booking-row-lock.js'
import type {
  AssignmentWithRelations,
  AssignBookingInput,
  UpdateDeliveryStatusInput,
  Delivery,
} from '../../types/assignment.types.js'

const DELIVERY_WITH_RELATIONS_SELECT = `
  delivery_id,
  booking_id,
  driver_id,
  truck_id,
  status,
  pickup_time,
  delivery_time,
  created_at,
  updated_at,
  is_vendor_supplied,
  vendor_name,
  vendor_contact,
  vendor_driver_name,
  vendor_driver_license,
  vendor_driver_phone,
  vendor_vehicle_plate,
  vendor_vehicle_type,
  vendor_driver_email,
  vendor_driver_user_id,
  second_driver_id,
  helper_name,
  second_driver:drivers!deliveries_second_driver_id_fkey (
    driver_id,
    license_number,
    license_expiry,
    is_external,
    vendor_name,
    users ( user_id, first_name, last_name, phone, email )
  ),
  drivers!deliveries_driver_id_fkey (
    driver_id,
    license_number,
    license_expiry,
    status,
    users (
      user_id,
      first_name,
      last_name,
      phone,
      email
    )
  ),
  trucks (
    truck_id,
    plate_number,
    status,
    truck_models ( vehicle_type, name )
  ),
  bookings (
    booking_id,
    origin,
    status,
    schedule_date,
    truck_type_needed,
    fleet_return_at,
    paused_at,
    pause_reason,
    clients (
      company_name
    )
  )
`

async function findByBookingId(bookingId: string): Promise<AssignmentWithRelations | null> {
  const { data, error } = await supabase
    .from('deliveries')
    .select(DELIVERY_WITH_RELATIONS_SELECT)
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as unknown as AssignmentWithRelations | null
}

async function findByDeliveryId(deliveryId: string): Promise<AssignmentWithRelations | null> {
  const { data, error } = await supabase
    .from('deliveries')
    .select(DELIVERY_WITH_RELATIONS_SELECT)
    .eq('delivery_id', deliveryId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as unknown as AssignmentWithRelations | null
}

async function findAll(): Promise<AssignmentWithRelations[]> {
  const { data, error } = await supabase
    .from('deliveries')
    .select(DELIVERY_WITH_RELATIONS_SELECT)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as unknown as AssignmentWithRelations[]
}

/** Statuses a crew may still be set or changed in: anything before the start. */
const CREWABLE_STATUSES = ['pending', 'approved', 'assigned']

async function assign(
  bookingId:  string,
  input:      AssignBookingInput,
  assignedBy: string | null,
  // Set when the vendor's driver was given app access: the drivers row and the
  // users row provisioned for them. Kept out of `deliveries.driver_id` on
  // purpose — see the comment on the driver_assignments write below.
  external?:  { driverId: string; userId: string } | null,
  // drivers.driver_id of the optional second driver, on either path. On the
  // vendor path it is a registered vendor driver.
  secondDriverId?: string | null,
): Promise<AssignmentWithRelations | null> {
  const now           = new Date().toISOString()
  const isVendor       = input.is_vendor_supplied === true
  const driverId       = isVendor ? null : input.driver_id ?? null
  const truckId        = isVendor ? null : input.truck_id ?? null

  // Which drivers row, if any, this booking should be visible to. On the company
  // path that is the assigned driver; on the vendor path it is the provisioned
  // external driver, when there is one.
  const crewDriverId   = isVendor ? external?.driverId ?? null : driverId

  // Vendor-supplied crew is snapshotted onto the delivery; company crew clears the
  // snapshot so re-assigning between paths never leaves stale details behind.
  const deliveryFields = {
    driver_id:             driverId,
    truck_id:              truckId,
    is_vendor_supplied:    isVendor,
    vendor_name:           isVendor ? input.vendor_name           ?? null : null,
    vendor_contact:        isVendor ? input.vendor_contact        ?? null : null,
    vendor_driver_name:    isVendor ? input.vendor_driver_name    ?? null : null,
    vendor_driver_license: isVendor ? input.vendor_driver_license ?? null : null,
    vendor_driver_phone:   isVendor ? input.vendor_driver_phone   ?? null : null,
    vendor_vehicle_plate:  isVendor ? input.vendor_vehicle_plate  ?? null : null,
    vendor_vehicle_type:   isVendor ? input.vendor_vehicle_type   ?? null : null,
    vendor_driver_email:   isVendor ? input.vendor_driver_email   ?? null : null,
    vendor_driver_user_id: isVendor ? external?.userId            ?? null : null,
    // On both paths: the delivery's record of who rode along. Cleared on a
    // re-assign without one, like every other crew field here.
    second_driver_id:      secondDriverId ?? null,
    // Information only; the service has already cleared it on a long route.
    helper_name:           input.helper_name?.trim() || null,
  }

  // The model of the vehicle becomes the booking's vehicle type: the client no
  // longer names one when booking, operations picks it here. A vendor vehicle has
  // no model row; its typed-in type stands in, when given. Read before the lock.
  let truckType: string | null = null
  if (isVendor) {
    truckType = input.vendor_vehicle_type?.trim() || null
  } else if (truckId) {
    const { data: truckRow } = await supabase
      .from('trucks')
      .select('truck_models ( name )')
      .eq('truck_id', truckId)
      .maybeSingle()
    const model = (truckRow as { truck_models?: { name?: string | null } | null } | null)?.truck_models
    truckType = model?.name ?? null
  }

  // truck_assignments references a registered fleet row (NOT NULL FK), so it
  // stays company-only — there is no trucks row for a vendor vehicle.
  //
  // driver_assignments is different: it is not just history, it is the table the
  // whole driver-facing side reads. findByDriverId lists a driver's work from it,
  // isDriverAssignedToBooking authorises every trip and proof write from it, and
  // resolveDriverUserIds picks notification recipients from it. So when a vendor
  // driver has been provisioned an account, they get a real row here — otherwise
  // they would sign in successfully and find an empty screen.
  //
  // deliveries.driver_id still stays NULL on the vendor path. That column is what
  // crewOnBooking reads to drive reserveCrew/releaseCrew, and a subcontractor has
  // no business in the company fleet-reservation state machine.
  //
  // Every crew write happens in one transaction holding the booking row lock,
  // the same lock the driver's start takes (lib/booking-row-lock). So a start and
  // a re-assign can never interleave: whichever commits first wins, and the other
  // reads what it left. A booking that has started is refused here — a crew
  // change on the road goes through the replacement flow, which keeps the record.
  await withBookingRowLock(bookingId, async (client, booking) => {
    if (!CREWABLE_STATUSES.includes(booking.status)) {
      throw new Error(
        booking.status === 'in_transit'
          ? 'Cannot change the driver or vehicle: the driver has already started this delivery.'
          : `Cannot assign a booking with status '${booking.status}'`,
      )
    }

    const cols = Object.keys(deliveryFields)
    const vals = cols.map((c) => (deliveryFields as Record<string, unknown>)[c])
    const { rowCount } = await client.query(
      `UPDATE deliveries SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = $${cols.length + 2}
        WHERE booking_id = $1`,
      [bookingId, ...vals, now],
    )
    if (!rowCount) {
      await client.query(
        `INSERT INTO deliveries (booking_id, ${cols.join(', ')}, status, created_at, updated_at)
         VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, 'pending', $${cols.length + 2}, $${cols.length + 2})`,
        [bookingId, ...vals, now],
      )
    }

    // Always clear prior rows first.
    await client.query('DELETE FROM driver_assignments WHERE booking_id = $1', [bookingId])
    await client.query('DELETE FROM truck_assignments  WHERE booking_id = $1', [bookingId])

    const crewRows = [
      crewDriverId   ? { driver_id: crewDriverId,   crew_role: 'lead'   } : null,
      secondDriverId ? { driver_id: secondDriverId, crew_role: 'second' } : null,
    ].filter((r): r is { driver_id: string; crew_role: string } => r !== null)

    for (const r of crewRows) {
      await client.query(
        `INSERT INTO driver_assignments (booking_id, driver_id, crew_role, assigned_at, assigned_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [bookingId, r.driver_id, r.crew_role, now, assignedBy],
      )
    }

    if (!isVendor) {
      await client.query(
        `INSERT INTO truck_assignments (booking_id, truck_id, assigned_at, assigned_by)
         VALUES ($1, $2, $3, $4)`,
        [bookingId, truckId, now, assignedBy],
      )
    }

    await client.query(
      `UPDATE bookings
          SET status = 'assigned',
              truck_type_needed = COALESCE($2, truck_type_needed),
              updated_at = $3
        WHERE booking_id = $1`,
      [bookingId, truckType, now],
    )
  })

  return findByBookingId(bookingId)
}

async function updateDeliveryStatus(
  bookingId: string,
  input:     UpdateDeliveryStatusInput,
): Promise<AssignmentWithRelations | null> {
  const now = new Date().toISOString()

  const updatePayload: Record<string, unknown> = {
    status:     input.status,
    updated_at: now,
  }
  if (input.pickup_time)   updatePayload.pickup_time   = input.pickup_time
  if (input.delivery_time) updatePayload.delivery_time = input.delivery_time

  const { error } = await supabase
    .from('deliveries')
    .update(updatePayload)
    .eq('booking_id', bookingId)
  if (error) throw error

  return findByBookingId(bookingId)
}

async function getAssignmentHistory(bookingId: string): Promise<{
  driver_assignments: Record<string, unknown>[]
  truck_assignments:  Record<string, unknown>[]
}> {
  const [driverRes, truckRes] = await Promise.all([
    supabase
      .from('driver_assignments')
      .select(`
        assignment_id, assigned_at, assigned_by, crew_role,
        drivers (
          driver_id, license_number,
          users ( first_name, last_name, email )
        )
      `)
      .eq('booking_id', bookingId)
      .order('assigned_at', { ascending: false }),
    supabase
      .from('truck_assignments')
      .select(`
        assignment_id, assigned_at, assigned_by,
        trucks (
          truck_id,
          plate_number,
          status,
          truck_models ( vehicle_type, name )
        )
      `)
      .eq('booking_id', bookingId)
      .order('assigned_at', { ascending: false }),
  ])

  if (driverRes.error) throw driverRes.error
  if (truckRes.error)  throw truckRes.error

  return {
    driver_assignments: (driverRes.data ?? []) as unknown as Record<string, unknown>[],
    truck_assignments:  (truckRes.data  ?? []) as unknown as Record<string, unknown>[],
  }
}

export const AssignmentModel = {
  findAll,
  findByBookingId,
  findByDeliveryId,
  assign,
  updateDeliveryStatus,
  getAssignmentHistory,
}