import { BookingModel } from '../../models/client/booking.model.js'
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
} from '../../types/client/booking.types.js'
import { optimizeDestinationsService } from '../maps/routeOptimization.service.js'
import { logEvent } from '../../lib/log-event.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateScheduleDate(scheduleDate: string): void {
  const [year, month, day] = scheduleDate.split('-').map(Number)
  const scheduled = new Date(year, month - 1, day)

  const now      = new Date()
  const earliest = new Date(now)
  earliest.setDate(earliest.getDate() + 7)
  const earliestDateOnly = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate())

  const maxDate = new Date(now)
  maxDate.setFullYear(maxDate.getFullYear() + 1)
  const maxDateOnly = new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate())

  if (scheduled < earliestDateOnly) {
    throw new Error('Booking must be scheduled at least 1 week in advance')
  }
  if (scheduled > maxDateOnly) {
    throw new Error('Booking cannot be scheduled more than 1 year in advance')
  }
}

// fix #6 — statuses from which a booking cannot be deleted
const NON_DELETABLE_STATUSES = ['approved', 'assigned', 'in_transit', 'completed']

// ---------------------------------------------------------------------------
// Paginated list
// ---------------------------------------------------------------------------

export interface PaginatedBookingsMeta {
  total:        number
  page:         number
  limit:        number
  totalPages:   number
  statusCounts: Record<string, number>
}

export async function getAllBookingsPaginatedService(params: {
  page:    number
  limit:   number
  status?: string | null
  search?: string | null
}): Promise<{ data: BookingWithRelations[]; meta: PaginatedBookingsMeta }> {
  const page  = Math.max(1, params.page)
  const limit = Math.min(Math.max(1, params.limit), 100)

  const [{ rows, total }, statusCounts] = await Promise.all([
    BookingModel.findAllPaginated({ page, limit, status: params.status, search: params.search }),
    BookingModel.countByStatus(),
  ])

  return {
    data: rows,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusCounts,
    },
  }
}

// ---------------------------------------------------------------------------
// Basic reads
// ---------------------------------------------------------------------------

export async function getAllBookingsService(): Promise<BookingWithRelations[]> {
  return await BookingModel.findAll() ?? []
}

export async function getBookingByIdService(bookingId: string): Promise<BookingWithRelations> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)
  return booking
}

export async function getBookingsByClientService(clientId: string): Promise<BookingWithRelations[]> {
  return await BookingModel.findByClientId(clientId) ?? []
}

export async function getBookingsByDriverService(driverId: string): Promise<BookingWithRelations[]> {
  return await BookingModel.findByDriverId(driverId) ?? []
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBookingService(
  input: CreateBookingInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  if (!input.destinations || input.destinations.length === 0) {
    throw new Error('At least one destination is required')
  }

  validateScheduleDate(input.schedule_date)

  const orders = input.destinations.map((d) => d.sequence_order)
  if (new Set(orders).size !== orders.length) {
    throw new Error('sequence_order must be unique per destination')
  }

  // Route optimisation — only when all coords are present
  const allHaveCoords   = input.destinations.every((d) => d.latitude != null && d.longitude != null)
  const originHasCoords = input.origin_latitude != null && input.origin_longitude != null

  if (allHaveCoords && originHasCoords) {
    try {
      const optimizedOrder = await optimizeDestinationsService(
        { latitude: input.origin_latitude!, longitude: input.origin_longitude! },
        input.destinations as Array<{ address: string; latitude: number; longitude: number; sequence_order: number }>,
        input.schedule_date,
        input.call_time,
      )
      input.destinations = input.destinations.map((dest) => {
        const match = optimizedOrder.find((o) => o.address === dest.address)
        return match ? { ...dest, sequence_order: match.optimized_sequence_order } : dest
      })
    } catch (err) {
      console.warn('Pre-creation route optimization failed, using original order:', err)
    }
  }

  const booking = await BookingModel.create(input)
  if (!booking) throw new Error('Failed to create booking')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_created',
    description: `Booking ${booking.booking_id} created for client ${booking.client_id}`,
    ip_address:  ip,
  })

  return booking
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateBookingService(
  bookingId: string,
  input: UpdateBookingInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (input.schedule_date) {
    validateScheduleDate(input.schedule_date)
  }

  const booking = await BookingModel.update(bookingId, input)
  if (!booking) throw new Error('Failed to update booking')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_updated',
    description: `Booking ${bookingId} updated`,
    ip_address:  ip,
  })

  return booking
}

// ---------------------------------------------------------------------------
// Status flow
// ---------------------------------------------------------------------------

export async function updateBookingStatusService(
  bookingId: string,
  status: string,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const statusOrder  = ['pending', 'approved', 'assigned', 'in_transit', 'completed', 'cancelled']
  const currentIndex = statusOrder.indexOf(existing.status)
  const newIndex     = statusOrder.indexOf(status)

  if (newIndex === currentIndex) return existing

  if (newIndex < currentIndex && status !== 'cancelled') {
    throw new Error(`Cannot change status from '${existing.status}' back to '${status}'`)
  }

  const booking = await BookingModel.updateStatus(bookingId, status)
  if (!booking) throw new Error('Failed to update booking status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `booking_${status}`,
    description: `Booking ${bookingId} marked as ${status}`,
    ip_address:  ip,
  })

  return booking
}

// ---------------------------------------------------------------------------
// Approval pipeline services (fix #4)
// ---------------------------------------------------------------------------

export async function accountingReviewService(
  bookingId: string,
  input: AccountingReviewInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.accounting_status !== 'pending') {
    throw new Error(`Booking has already been reviewed by accounting (status: ${existing.accounting_status})`)
  }

  const booking = await BookingModel.updateAccountingStatus(bookingId, input)
  if (!booking) throw new Error('Failed to update accounting status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `accounting_${input.accounting_status}`,
    description: `Booking ${bookingId} ${input.accounting_status} by accounting`,
    ip_address:  ip,
  })

  return booking
}

export async function gmReviewService(
  bookingId: string,
  input: GmReviewInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.accounting_status !== 'forwarded' && existing.accounting_status !== 'approved') {
    throw new Error('Booking must be approved or forwarded by accounting before GM review')
  }
  if (existing.gm_status !== 'pending') {
    throw new Error(`Booking has already been reviewed by GM (status: ${existing.gm_status})`)
  }

  const booking = await BookingModel.updateGmStatus(bookingId, input)
  if (!booking) throw new Error('Failed to update GM status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `gm_${input.gm_status}`,
    description: `Booking ${bookingId} ${input.gm_status} by GM`,
    ip_address:  ip,
  })

  return booking
}

export async function opsAssignService(
  bookingId: string,
  input: OpsAssignInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.gm_status !== 'approved') {
    throw new Error('Booking must be approved by GM before operations assignment')
  }
  if (existing.ops_status !== 'pending') {
    throw new Error('Booking has already been assigned by operations')
  }

  const booking = await BookingModel.updateOpsStatus(bookingId, input)
  if (!booking) throw new Error('Failed to update ops status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'ops_assigned',
    description: `Booking ${bookingId} assigned by operations`,
    ip_address:  ip,
  })

  return booking
}

export async function fleetApproveService(
  bookingId: string,
  input: FleetApproveInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.ops_status !== 'assigned') {
    throw new Error('Booking must be assigned by operations before fleet approval')
  }
  if (existing.fleet_status !== 'pending') {
    throw new Error('Booking has already been reviewed by fleet')
  }

  const booking = await BookingModel.updateFleetStatus(bookingId, input)
  if (!booking) throw new Error('Failed to update fleet status')

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'fleet_approved',
    description: `Booking ${bookingId} approved by fleet`,
    ip_address:  ip,
  })

  return booking
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteBookingService(
  bookingId: string,
  userId?: string | null,
  ip?: string | null,
): Promise<boolean> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  // fix #6 — block deletion once the booking has moved past pending
  if (NON_DELETABLE_STATUSES.includes(existing.status)) {
    throw new Error(`Cannot delete a booking with status '${existing.status}'`)
  }

  const result = await BookingModel.remove(bookingId)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'booking_deleted',
    description: `Booking ${bookingId} deleted`,
    ip_address:  ip,
  })

  return result
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export async function getDestinationsByBookingService(bookingId: string): Promise<BookingDestination[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  return await BookingModel.findDestinationsByBookingId(bookingId) ?? []
}

export async function updateDestinationService(
  destinationId: string,
  input: UpdateDestinationInput,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingDestination> {
  const destination = await BookingModel.updateDestination(destinationId, input)
  if (!destination) throw new Error(`Destination with ID ${destinationId} not found`)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'destination_updated',
    description: `Destination ${destinationId} updated`,
    ip_address:  ip,
  })

  return destination
}

export async function updateDestinationStatusService(
  destinationId: string,
  status: string,
  deliveredAt?: string,
  userId?: string | null,
  ip?: string | null,
): Promise<BookingDestination> {
  const destination = await BookingModel.updateDestinationStatus(destinationId, status)
  if (!destination) throw new Error(`Destination with ID ${destinationId} not found`)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      `destination_${status}`,
    description: `Destination ${destinationId} marked as ${status}`,
    ip_address:  ip,
  })

  return destination
}

export async function deleteDestinationService(
  destinationId: string,
  userId?: string | null,
  ip?: string | null,
): Promise<boolean> {
  const result = await BookingModel.removeDestination(destinationId)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'destination_deleted',
    description: `Destination ${destinationId} deleted`,
    ip_address:  ip,
  })

  return result
}

// ---------------------------------------------------------------------------
// Cargo items
// ---------------------------------------------------------------------------

export async function getCargoItemsByBookingService(bookingId: string): Promise<BookingCargoItem[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)
  return await BookingModel.findCargoItemsByBookingId(bookingId) ?? []
}

export async function upsertCargoItemService(
  bookingId: string,
  item: Partial<BookingCargoItem> & { item_id?: string },
  userId?: string | null,
  ip?: string | null,
): Promise<BookingCargoItem> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const result = await BookingModel.upsertCargoItem(bookingId, item)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      item.item_id ? 'cargo_item_updated' : 'cargo_item_created',
    description: `Cargo item ${result.item_id} upserted for booking ${bookingId}`,
    ip_address:  ip,
  })

  return result
}

export async function deleteCargoItemService(
  itemId: string,
  userId?: string | null,
  ip?: string | null,
): Promise<boolean> {
  const result = await BookingModel.removeCargoItem(itemId)

  logEvent({
    user_id:     userId,
    log_type:    'booking',
    action:      'cargo_item_deleted',
    description: `Cargo item ${itemId} deleted`,
    ip_address:  ip,
  })

  return result
}