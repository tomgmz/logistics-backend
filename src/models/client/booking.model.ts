import { supabase } from '../../lib/supabase.js'
import {
  CreateBookingInput,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
} from '../../types/client/booking.types.js'

//Bookings
async function findAll(): Promise<BookingWithRelations[]> {
  const { data, error } = await supabase
    .rpc('get_all_bookings')

  if (error) throw error
  return data ?? []
}

async function findById(bookingId: string): Promise<BookingWithRelations | null> {
  const { data, error } = await supabase
    .rpc('get_booking_by_id', { p_booking_id: bookingId })

  if (error) throw error
  return data?.[0] ?? null
}

async function findByClientId(clientId: string): Promise<BookingWithRelations[]> {
  const { data, error } = await supabase
    .rpc('get_bookings_by_client', { p_client_id: clientId })

  if (error) throw error
  return data ?? []
}

async function create(input: CreateBookingInput): Promise<BookingWithRelations | null> {
  const { destinations, ...bookingData } = input

  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert(bookingData)
    .select()
    .single()

  if (bookingError) throw bookingError

  const destinationRows = destinations.map((d) => ({
    ...d,
    booking_id: booking.booking_id,
  }))

  const { error: destinationError } = await supabase
    .from('booking_destinations')
    .insert(destinationRows)

  if (destinationError) throw destinationError

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

async function remove(bookingId: string): Promise<boolean> {
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('booking_id', bookingId)

  if (error) throw error
  return true
}

//Booking Destination
async function findDestinationsByBookingId(bookingId: string): Promise<BookingDestination[]> {
  const { data, error } = await supabase
    .from('booking_destinations')
    .select('*')
    .eq('booking_id', bookingId)
    .order('sequence_order', { ascending: true })

  if (error) throw error
  return data ?? []
}

async function updateDestination(destinationId: string, input: UpdateDestinationInput): Promise<BookingDestination> {
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
  deliveredAt?: string
): Promise<BookingDestination> {
  const { data, error } = await supabase
    .from('booking_destinations')
    .update({
      status,
      delivered_at: deliveredAt ?? (status === 'delivered' ? new Date().toISOString() : null),
    })
    .eq('destination_id', destinationId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function removeDestination(destinationId: string): Promise<boolean> {
  const { error } = await supabase
    .from('booking_destinations')
    .delete()
    .eq('destination_id', destinationId)

  if (error) throw error
  return true
}

export const BookingModel = {
  findAll,
  findById,
  findByClientId,
  create,
  update,
  updateStatus,
  remove,
  findDestinationsByBookingId,
  updateDestination,
  updateDestinationStatus,
  removeDestination,
}

