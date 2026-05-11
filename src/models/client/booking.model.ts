import { supabase } from '../../lib/supabase.js'
import {
  CreateBookingInput,
  UpdateBookingInput,
  UpdateDestinationInput,
  BookingWithRelations,
  BookingDestination,
} from '../../types/client/booking.types.js'

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
  return data ?? null
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
  _deliveredAt?: string
): Promise<BookingDestination> {
  const { data, error } = await supabase
    .from('booking_destinations')
    .update({
      status,
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
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

async function findByDriverId(driverId: string): Promise<BookingWithRelations[]> {
  const { data, error } = await supabase
    .from('driver_assignments')
    .select(`
      assignment_id,
      assigned_at,
      bookings (
        booking_id,
        client_id,
        origin,
        origin_latitude,
        origin_longitude,
        truck_type_needed,
        cargo_details,
        schedule_date,
        call_time,
        status,
        total_cost,
        estimated_delivery,
        required_volume_cbm,
        required_weight_kg,
        required_length_cm,
        stackable_required,
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
          address,
          sequence_order,
          status,
          delivered_at,
          notes,
          latitude,
          longitude,
          created_at
        ),
        truck_assignments (
          assignment_id,
          truck_id,
          assigned_at,
          trucks (
            plate_number,
            truck_type,
            capacity_tons
          )
        )
      )
    `)
    .eq('driver_id', driverId)
    .order('assigned_at', { ascending: false })

  if (error) throw error

  return (data ?? [])
    .map((row: any) => row.bookings)
    .filter(Boolean) as BookingWithRelations[]
}

export const BookingModel = {
  findAll,
  findById,
  findByClientId,
  findByDriverId,
  create,
  update,
  updateStatus,
  remove,
  findDestinationsByBookingId,
  updateDestination,
  updateDestinationStatus,
  removeDestination,
}