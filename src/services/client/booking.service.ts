import { BookingModel } from '../../models/client/booking.model.js'
import {
  CreateBookingInput,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
  ParsedCargoDetails,
} from '../../types/client/booking.types.js'
import { optimizeDestinationsService } from '../maps/routeOptimization.service.js'

function parseCargoDetails(raw: string | null | undefined): ParsedCargoDetails | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as ParsedCargoDetails
  } catch {
    return null
  }
}

export async function getAllBookingsService(): Promise<BookingWithRelations[]> {
  const bookings = await BookingModel.findAll()
  if (!bookings || bookings.length === 0) throw new Error('No bookings found')
  return bookings
}

export async function getBookingByIdService(bookingId: string): Promise<BookingWithRelations> {
  const booking = await BookingModel.findById(bookingId)
  if (!booking) throw new Error(`Booking with ID ${bookingId} not found`)

  return {
    ...booking,
    parsed_cargo: parseCargoDetails(booking.cargo_details),
  }
}

export async function getBookingsByClientService(clientId: string): Promise<BookingWithRelations[]> {
  const bookings = await BookingModel.findByClientId(clientId)
  if (!bookings || bookings.length === 0) throw new Error('No bookings found for this client')
  return bookings
}

export async function createBookingService(input: CreateBookingInput): Promise<BookingWithRelations> {
  if (!input.destinations || input.destinations.length === 0) {
    throw new Error('At least one destination is required')
  }

  const orders = input.destinations.map((d) => d.sequence_order)
  if (new Set(orders).size !== orders.length) {
    throw new Error('sequence_order must be unique per destination')
  }

  const allHaveCoords   = input.destinations.every((d) => d.latitude != null && d.longitude != null)
  const originHasCoords = input.origin_latitude != null && input.origin_longitude != null

  if (allHaveCoords && originHasCoords) {
    try {
      const optimizedOrder = await optimizeDestinationsService(
        { latitude: input.origin_latitude!, longitude: input.origin_longitude! },
        input.destinations as Array<{ address: string; latitude: number; longitude: number; sequence_order: number }>
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
  return booking
}

export async function updateBookingService(
  bookingId: string,
  input: UpdateBookingInput
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const booking = await BookingModel.update(bookingId, input)
  if (!booking) throw new Error('Failed to update booking')
  return booking
}

export async function updateBookingStatusService(
  bookingId: string,
  status: string
): Promise<BookingWithRelations> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const statusOrder  = ['pending', 'assigned', 'in_transit', 'completed', 'cancelled']
  const currentIndex = statusOrder.indexOf(existing.status)
  const newIndex     = statusOrder.indexOf(status)

  if (newIndex < currentIndex && status !== 'cancelled') {
    throw new Error(`Cannot change status from '${existing.status}' back to '${status}'`)
  }

  const booking = await BookingModel.updateStatus(bookingId, status)
  if (!booking) throw new Error('Failed to update booking status')
  return booking
}

export async function deleteBookingService(bookingId: string): Promise<boolean> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  if (existing.status === 'in_transit') {
    throw new Error('Cannot delete a booking that is currently in transit')
  }

  return BookingModel.remove(bookingId)
}

export async function getDestinationsByBookingService(bookingId: string): Promise<BookingDestination[]> {
  const existing = await BookingModel.findById(bookingId)
  if (!existing) throw new Error(`Booking with ID ${bookingId} not found`)

  const destinations = await BookingModel.findDestinationsByBookingId(bookingId)
  if (!destinations || destinations.length === 0) throw new Error('No destinations found for this booking')
  return destinations
}

export async function updateDestinationService(
  destinationId: string,
  input: UpdateDestinationInput
): Promise<BookingDestination> {
  const destination = await BookingModel.updateDestination(destinationId, input)
  if (!destination) throw new Error(`Destination with ID ${destinationId} not found`)
  return destination
}

export async function updateDestinationStatusService(
  destinationId: string,
  status: string,
  deliveredAt?: string
): Promise<BookingDestination> {
  const destination = await BookingModel.updateDestinationStatus(destinationId, status, deliveredAt)
  if (!destination) throw new Error(`Destination with ID ${destinationId} not found`)
  return destination
}

export async function deleteDestinationService(destinationId: string): Promise<boolean> {
  return BookingModel.removeDestination(destinationId)
}