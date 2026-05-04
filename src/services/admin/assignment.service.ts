import { AssignmentModel } from '../../models/admin/assignment.model.js'
import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'
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

export async function assignBookingService(
  bookingId: string,
  input:     AssignBookingInput,
  userId?:   string | null,
  ip?:       string | null,
): Promise<AssignmentWithRelations> {
  await assertBookingAssignable(bookingId)
  await Promise.all([
    assertDriverExists(input.driver_id),
    assertTruckExists(input.truck_id),
  ])

  const assignment = await AssignmentModel.assign(bookingId, input, userId ?? null)
  if (!assignment) throw new Error('Failed to create assignment')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_assigned',
    description: `Booking ${bookingId} assigned to driver ${input.driver_id} with truck ${input.truck_id}`,
    ip_address:  ip,
  })

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
    description: `Delivery for booking ${bookingId} marked as ${input.status}`,
    ip_address:  ip,
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