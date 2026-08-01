import { supabase } from '../../lib/supabase.js'
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
  drivers (
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

async function assign(
  bookingId:  string,
  input:      AssignBookingInput,
  assignedBy: string | null,
): Promise<AssignmentWithRelations | null> {
  const now           = new Date().toISOString()
  const isVendor       = input.is_vendor_supplied === true
  const driverId       = isVendor ? null : input.driver_id ?? null
  const truckId        = isVendor ? null : input.truck_id ?? null

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
  }

  const { data: existing } = await supabase
    .from('deliveries')
    .select('delivery_id')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (existing?.delivery_id) {
    const { error: updateErr } = await supabase
      .from('deliveries')
      .update({ ...deliveryFields, updated_at: now })
      .eq('delivery_id', existing.delivery_id)
    if (updateErr) throw updateErr
  } else {
    const { error: insertErr } = await supabase
      .from('deliveries')
      .insert({
        booking_id: bookingId,
        ...deliveryFields,
        status:     'pending',
        created_at: now,
        updated_at: now,
      })
    if (insertErr) throw insertErr
  }

  // History tables reference registered fleet rows (NOT NULL FKs), so they only
  // apply to the company path. Always clear prior rows first.
  const { error: delDriverErr } = await supabase
    .from('driver_assignments')
    .delete()
    .eq('booking_id', bookingId)
  if (delDriverErr) throw delDriverErr

  const { error: delTruckErr } = await supabase
    .from('truck_assignments')
    .delete()
    .eq('booking_id', bookingId)
  if (delTruckErr) throw delTruckErr

  if (!isVendor) {
    const { error: insDriverErr } = await supabase
      .from('driver_assignments')
      .insert({
        booking_id:  bookingId,
        driver_id:   driverId,
        assigned_at: now,
        assigned_by: assignedBy,
      })
    if (insDriverErr) throw insDriverErr

    const { error: insTruckErr } = await supabase
      .from('truck_assignments')
      .insert({
        booking_id:  bookingId,
        truck_id:    truckId,
        assigned_at: now,
        assigned_by: assignedBy,
      })
    if (insTruckErr) throw insTruckErr
  }

  const { error: bookingErr } = await supabase
    .from('bookings')
    .update({ status: 'assigned', updated_at: now })
    .eq('booking_id', bookingId)
    // Allow updating booking status to 'assigned' regardless of prior intermediate
    // approval status so admin or other roles that assign after approval
    // correctly transition the booking.
  if (bookingErr) throw bookingErr

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
        assignment_id, assigned_at, assigned_by,
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