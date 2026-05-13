import { supabase } from '../../lib/supabase.js'
import { OptimizedStop } from '../../types/maps/routeOptimization.types.js'

async function getBookingWithDestinations(bookingId: string) {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      booking_id,
      origin,
      origin_latitude,
      origin_longitude,
      status,
      schedule_date,
      call_time,
      booking_destinations (
        destination_id,
        address,
        latitude,
        longitude,
        sequence_order,
        status,
        notes
      )
    `)
    .eq('booking_id', bookingId)
    .single()

  if (error) throw error
  return data
}

async function saveOriginCoordinates(
  bookingId: string,
  latitude: number,
  longitude: number
) {
  const { error } = await supabase
    .from('bookings')
    .update({
      origin_latitude:  latitude,
      origin_longitude: longitude,
      updated_at:       new Date().toISOString(),
    })
    .eq('booking_id', bookingId)

  if (error) throw error
}

async function saveDestinationCoordinates(
  destinationId: string,
  latitude: number,
  longitude: number
) {
  const { error } = await supabase
    .from('booking_destinations')
    .update({ latitude, longitude })
    .eq('destination_id', destinationId)

  if (error) throw error
}

async function saveOptimizedOrder(optimizedStops: OptimizedStop[]) {
  await Promise.all(
    optimizedStops.map(async (stop) => {
      const { error } = await supabase
        .from('booking_destinations')
        .update({ sequence_order: stop.optimized_sequence_order })
        .eq('destination_id', stop.destination_id)

      if (error) throw error
    })
  )
}

export const RouteOptimizationModel = {
  getBookingWithDestinations,
  saveOriginCoordinates,
  saveDestinationCoordinates,
  saveOptimizedOrder,
}