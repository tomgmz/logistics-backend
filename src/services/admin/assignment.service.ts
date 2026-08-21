import { AssignmentModel } from '../../models/admin/assignment.model.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { notifyStage } from '../notification/notification.service.js'
import { bookingRefById } from '../../lib/booking-ref.js'
import {
  assertDriverAssignable,
  assertTruckPassedInspection,
  crewOnBooking,
  releaseCrew,
  reserveCrew,
} from './fleet-availability.service.js'
import type {
  AssignmentWithRelations,
  AssignBookingInput,
  UpdateDeliveryStatusInput,
} from '../../types/assignment.types.js'

async function assertBookingAssignable(bookingId: string): Promise<void> {
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_id, status')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Booking with ID ${bookingId} not found`)

  const nonAssignable = ['completed', 'cancelled']
  if (nonAssignable.includes(data.status)) {
    throw new Error(`Cannot assign a booking with status '${data.status}'`)
  }
}

async function assertDriverExists(driverId: string): Promise<void> {
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id')
    .eq('driver_id', driverId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Driver with ID ${driverId} not found`)
}

async function assertTruckExists(truckId: string): Promise<void> {
  const { data, error } = await supabase
    .from('trucks')
    .select('truck_id')
    .eq('truck_id', truckId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Truck with ID ${truckId} not found`)
}

/** Plate + model of a truck, for the fleet manager's notification copy. */
async function truckLabel(truckId: string): Promise<string> {
  const { data, error } = await supabase
    .from('trucks')
    .select('plate_number, truck_models ( name, vehicle_type )')
    .eq('truck_id', truckId)
    .maybeSingle()

  if (error || !data) return 'A vehicle'
  const model = (data as any).truck_models
  const name  = model?.name ?? model?.vehicle_type ?? null
  return name ? `${data.plate_number} · ${name}` : String(data.plate_number)
}

export async function assignBookingService(
  bookingId: string,
  input:     AssignBookingInput,
  userId?:   string | null,
  ip?:       string | null,
): Promise<AssignmentWithRelations> {
  await assertBookingAssignable(bookingId)

  // Whoever is on the booking right now — they get stood down if this call swaps
  // in a different driver/vehicle, and stay valid if they are being kept.
  const previous = await crewOnBooking(bookingId)

  if (input.is_vendor_supplied) {
    if (!input.vendor_driver_name) throw new Error('Vendor driver name is required')
    if (!input.vendor_vehicle_plate) throw new Error('Vendor vehicle plate is required')
  } else {
    if (!input.driver_id) throw new Error('driver_id is required')
    if (!input.truck_id)  throw new Error('truck_id is required')
    await Promise.all([
      assertDriverExists(input.driver_id),
      assertTruckExists(input.truck_id),
    ])
    // Operations may only pick from the vetted pools: a driver who marked
    // themselves available, and a vehicle whose latest BLOWBAGETS check passed.
    await Promise.all([
      assertDriverAssignable(input.driver_id, previous.driver_id),
      assertTruckPassedInspection(input.truck_id),
    ])
  }

  const assignment = await AssignmentModel.assign(bookingId, input, userId ?? null)
  if (!assignment) throw new Error('Failed to create assignment')

  const crewDescription = input.is_vendor_supplied
    ? `vendor driver ${input.vendor_driver_name} with vehicle ${input.vendor_vehicle_plate}`
    : `driver ${input.driver_id} with truck ${input.truck_id}`
  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_assigned',
    description: `Booking ${await bookingRefById(bookingId)} assigned to ${crewDescription}`,

  })

  // Reserve the new crew and release whoever was displaced by this call. A
  // displaced driver never drove, so they go back to 'available' — they stay in
  // the pool they opted into rather than having to opt in again.
  const nextDriverId = input.is_vendor_supplied ? null : input.driver_id ?? null
  const nextTruckId  = input.is_vendor_supplied ? null : input.truck_id  ?? null
  await releaseCrew(
    previous.driver_id && previous.driver_id !== nextDriverId ? previous.driver_id : null,
    previous.truck_id  && previous.truck_id  !== nextTruckId  ? previous.truck_id  : null,
    'available',
  )
  await reserveCrew(nextDriverId, nextTruckId)

  // The booking is now crewed: tell the driver they have a delivery, and tell the
  // fleet manager one of their vehicles has been taken.
  const advanced = await BookingModel.updateOpsStatus(bookingId, { ops_status: 'assigned' })
  const booking  = advanced ?? (await BookingModel.findById(bookingId))
  if (booking) {
    void notifyStage('assigned', booking)
    const label = nextTruckId
      ? await truckLabel(nextTruckId)
      : input.vendor_vehicle_plate ?? 'A vendor-supplied vehicle'
    void notifyStage('vehicle_assigned', booking, { vehicleLabel: label })
  }

  return assignment
}

export async function getAssignmentByBookingService(
  bookingId: string,
): Promise<AssignmentWithRelations> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('booking_id')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  const assignment = await AssignmentModel.findByBookingId(bookingId)
  if (!assignment) throw new Error(`No assignment found for booking ${bookingId}`)

  return assignment
}

export async function getAllAssignmentsService(): Promise<AssignmentWithRelations[]> {
  return AssignmentModel.findAll()
}

export async function updateDeliveryStatusService(
  bookingId: string,
  input:     UpdateDeliveryStatusInput,
  userId?:   string | null,
  ip?:       string | null,
): Promise<AssignmentWithRelations> {
  const existing = await AssignmentModel.findByBookingId(bookingId)
  if (!existing) throw new Error(`No delivery found for booking ${bookingId}`)

  const updated = await AssignmentModel.updateDeliveryStatus(bookingId, input)
  if (!updated) throw new Error('Failed to update delivery status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `delivery_${input.status}`,
    description: `Delivery for booking ${await bookingRefById(bookingId)} marked as ${input.status}`,

  })

  return updated
}

export async function getAssignmentHistoryService(bookingId: string) {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('booking_id')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  return AssignmentModel.getAssignmentHistory(bookingId)
}
