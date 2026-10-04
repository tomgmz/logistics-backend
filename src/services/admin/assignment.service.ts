import { AssignmentModel } from '../../models/admin/assignment.model.js'
import { checkTruckCapacity, type CapacityWarning } from '../../lib/cargo-capacity.js'
import { BookingModel } from '../../models/client/booking.model.js'
import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
import { notifyStage } from '../notification/notification.service.js'
import { bookingRefById } from '../../lib/booking-ref.js'
import { refreshPlannedEta } from '../maps/planned-eta.service.js'
import {
  findExternalDriverForAssignment,
  issueInvite,
  type ExternalDriverForAssignment,
} from '../auth/driver-enrollment.service.js'
import {
  assertDriverAssignable,
  assertTruckAssignable,
  crewOnBooking,
  releaseCrew,
  reserveCrew,
} from './fleet-availability.service.js'
import type {
  AssignmentWithRelations,
  AssignBookingInput,
  UpdateDeliveryStatusInput,
} from '../../types/assignment.types.js'

/** Checks the booking can still be crewed, and hands back the day it runs. */
async function assertBookingAssignable(bookingId: string): Promise<{ scheduleDate: string | null }> {
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_id, status, schedule_date')
    .eq('booking_id', bookingId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Booking with ID ${bookingId} not found`)

  const nonAssignable = ['delivered', 'completed', 'cancelled']
  if (nonAssignable.includes(data.status)) {
    throw new Error(`Cannot assign a booking with status '${data.status}'`)
  }

  return { scheduleDate: data.schedule_date ? String(data.schedule_date).slice(0, 10) : null }
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
): Promise<AssignmentWithRelations & { capacity_warning: CapacityWarning | null }> {
  const { scheduleDate } = await assertBookingAssignable(bookingId)

  // Whoever is on the booking right now — they get stood down if this call swaps
  // in a different driver/vehicle, and stay valid if they are being kept.
  const previous = await crewOnBooking(bookingId)

  // The registered vendor driver, on the vendor path. Read before anything is
  // written, so a revoked or deleted driver is refused with the booking still
  // uncrewed, and their details (plus their vendor) are copied onto the delivery
  // from the record rather than from whatever the browser sent.
  let external: ExternalDriverForAssignment | null = null
  // The optional second vendor driver, read and checked the same way.
  let externalSecond: ExternalDriverForAssignment | null = null
  // drivers.driver_id of the second driver on either path, for driver_assignments.
  let secondDriverId: string | null = null

  // A driver already on this booking (as main or second) stays valid while the
  // crew is edited — they read as 'assigned', which would otherwise block them,
  // and swapping the two around must be allowed.
  const alreadyOnBooking = (driverId: string) =>
    driverId === previous.driver_id || driverId === previous.second_driver_id
  const currentFor = (driverId: string) => (alreadyOnBooking(driverId) ? driverId : null)

  if (input.is_vendor_supplied) {
    if (!input.vendor_driver_user_id) throw new Error('Choose the vendor driver')
    if (!input.vendor_vehicle_plate) throw new Error('Vendor vehicle plate is required')
    if (input.second_vendor_driver_user_id && input.second_vendor_driver_user_id === input.vendor_driver_user_id) {
      throw new Error('The second driver must be a different person from the main driver')
    }
    ;[external, externalSecond] = await Promise.all([
      findExternalDriverForAssignment(input.vendor_driver_user_id),
      input.second_vendor_driver_user_id
        ? findExternalDriverForAssignment(input.second_vendor_driver_user_id)
        : Promise.resolve(null),
    ])
    secondDriverId = externalSecond?.driverId ?? null
    input = { ...input, ...external.snapshot }
  } else {
    if (!input.driver_id) throw new Error('driver_id is required')
    if (!input.truck_id)  throw new Error('truck_id is required')
    const second = input.second_driver_id ?? null
    if (second && second === input.driver_id) {
      throw new Error('The second driver must be a different person from the main driver')
    }
    await Promise.all([
      assertDriverExists(input.driver_id),
      assertTruckExists(input.truck_id),
      second ? assertDriverExists(second) : Promise.resolve(),
    ])
    // Operations may only pick from the vetted pools: a driver who ticked this
    // booking's day on their calendar and is not otherwise stopped, and a
    // vehicle whose latest BLOWBAGETS check passed. The second driver is held
    // to exactly the same rules as the main one.
    await Promise.all([
      assertDriverAssignable(input.driver_id, currentFor(input.driver_id), scheduleDate),
      assertTruckAssignable(input.truck_id, previous.truck_id),
      second ? assertDriverAssignable(second, currentFor(second), scheduleDate) : Promise.resolve(),
    ])
    secondDriverId = second
  }

  // Does the chosen vehicle actually fit the load? Advisory, not a gate — see
  // lib/cargo-capacity. Runs before the write so the warning describes the
  // vehicle being assigned, and never blocks it.
  const capacityWarning = input.is_vendor_supplied || !input.truck_id
    ? null
    : await checkTruckCapacity(bookingId, input.truck_id).catch((err) => {
        console.warn('[assignment] capacity check failed', bookingId, err)
        return null
      })

  const assignment = await AssignmentModel.assign(bookingId, input, userId ?? null, external, secondDriverId)
  if (!assignment) throw new Error('Failed to create assignment')

  // An overloaded assignment is a real decision someone made; put it on the
  // record rather than leaving it as a toast the operator can dismiss.
  if (capacityWarning) {
    logEvent({
      user_id:     userId,
      log_type:    'booking',
      action:      'assignment_capacity_warning',
      description:
        `Booking ${await bookingRefById(bookingId)} assigned to a vehicle that may not fit the load — ` +
        capacityWarning.reasons.join(' '),
    })
  }

  const crewDescription = input.is_vendor_supplied
    ? `vendor driver ${input.vendor_driver_name} with vehicle ${input.vendor_vehicle_plate}`
    : `driver ${input.driver_id} with truck ${input.truck_id}`
  const secondDescription = externalSecond
    ? ` and second vendor driver ${externalSecond.snapshot.vendor_driver_name}`
    : secondDriverId ? ` and second driver ${secondDriverId}` : ''
  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_assigned',
    description: `Booking ${await bookingRefById(bookingId)} assigned to ${crewDescription}${secondDescription}`,

  })

  // Reserve the new crew and release whoever was displaced by this call.
  // Only company drivers are reserved: a vendor second driver, like the main
  // vendor driver, stays out of the company reservation state machine.
  const nextDriverId = input.is_vendor_supplied ? null : input.driver_id ?? null
  const nextSecondId = input.is_vendor_supplied ? null : secondDriverId
  const nextTruckId  = input.is_vendor_supplied ? null : input.truck_id  ?? null
  const staying      = new Set([nextDriverId, nextSecondId].filter(Boolean))
  await releaseCrew(
    previous.driver_id        && !staying.has(previous.driver_id)        ? previous.driver_id        : null,
    previous.truck_id         && previous.truck_id !== nextTruckId        ? previous.truck_id         : null,
    previous.second_driver_id && !staying.has(previous.second_driver_id) ? previous.second_driver_id : null,
  )
  await reserveCrew(nextDriverId, nextTruckId, nextSecondId)

  // A vendor driver who has not set up the app yet gets a fresh setup link now,
  // naming this booking. Fire-and-forget, like the welcome email on driver
  // creation: the assignment is already committed and correct, and a Brevo
  // outage must not undo it. If the email fails the invite is re-sendable from
  // the booking's assignment card.
  const ref = external?.needsInvite || externalSecond?.needsInvite ? await bookingRefById(bookingId) : null
  for (const driver of [external, externalSecond]) {
    if (!driver?.needsInvite) continue
    void issueInvite({
      userId:     driver.userId,
      email:      driver.snapshot.vendor_driver_email,
      bookingId,
      bookingRef: ref,
      firstName:  driver.firstName,
      actorId:    userId ?? null,
    }).catch((err) => {
      console.error('[assignment] failed to send driver enrollment invite', bookingId, err)
    })
  }

  // The booking is now crewed: tell the driver they have a delivery, and tell the
  // fleet manager one of their vehicles has been taken.
  await BookingModel.recordDecision(bookingId, 'ops', userId)
  const advanced = await BookingModel.updateOpsStatus(bookingId, { ops_status: 'assigned' })
  const booking  = advanced ?? (await BookingModel.findById(bookingId))
  if (booking) {
    void notifyStage('assigned', booking)
    const label = nextTruckId
      ? await truckLabel(nextTruckId)
      : input.vendor_vehicle_plate ?? 'A vendor-supplied vehicle'
    void notifyStage('vehicle_assigned', booking, { vehicleLabel: label })
  }

  // First moment the booking has a truck, and so a plan to estimate.
  void refreshPlannedEta(bookingId)

  return { ...assignment, capacity_warning: capacityWarning }
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
