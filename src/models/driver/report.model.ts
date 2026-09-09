import { supabase } from '../../lib/supabase.js'
import type {
  DriverReport,
  CreateDriverReportInput,
  ReportStatus,
} from '../../types/driver/report.types.js'

/**
 * Incidents raised by a driver from the road.
 *
 * One table for both the quick alert and the detailed form — see the
 * 20260910010000_driver_reports migration for why they are the same row.
 */

const REPORT_WITH_RELATIONS_SELECT = `
  *,
  bookings ( booking_id, reference_number, origin ),
  trucks ( truck_id, plate_number, truck_models ( name, vehicle_type ) )
`

async function create(driverId: string, input: CreateDriverReportInput): Promise<DriverReport> {
  const { data, error } = await supabase
    .from('driver_reports')
    .insert({
      driver_id:  driverId,
      booking_id: input.booking_id ?? null,
      truck_id:   input.truck_id   ?? null,
      source:     input.source,

      incident_type: input.incident_type ?? null,
      sub_type:      input.sub_type      ?? null,
      description:   input.description   ?? null,

      photo_urls: input.photo_urls ?? [],
      video_urls: input.video_urls ?? [],

      latitude:   input.latitude   ?? null,
      longitude:  input.longitude  ?? null,
      accuracy_m: input.accuracy_m ?? null,
      address:    input.address    ?? null,

      // Stamped here rather than trusting a device clock: the check is evidence,
      // and a phone's time is the driver's to set.
      blowbagets_check: input.blowbagets_items
        ? { items: input.blowbagets_items, checked_at: new Date().toISOString() }
        : null,
      trip_can_continue: input.trip_can_continue ?? null,
    })
    .select(REPORT_WITH_RELATIONS_SELECT)
    .single()

  if (error) throw error
  return data as unknown as DriverReport
}

/** One driver's own reports, newest first — the list the mobile screen shows. */
async function findByDriverId(driverId: string): Promise<DriverReport[]> {
  const { data, error } = await supabase
    .from('driver_reports')
    .select(REPORT_WITH_RELATIONS_SELECT)
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as unknown as DriverReport[]
}

async function findById(reportId: string): Promise<DriverReport | null> {
  const { data, error } = await supabase
    .from('driver_reports')
    .select(REPORT_WITH_RELATIONS_SELECT)
    .eq('report_id', reportId)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as unknown as DriverReport | null
}

/** Operations' queue. `status` narrows it; omitted, it is everything. */
async function findAll(status?: ReportStatus | null): Promise<DriverReport[]> {
  let query = supabase
    .from('driver_reports')
    .select(`${REPORT_WITH_RELATIONS_SELECT}, drivers ( driver_id, users ( first_name, last_name, phone ) )`)
    .order('created_at', { ascending: false })

  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as unknown as DriverReport[]
}

/**
 * Add to a report that already exists.
 *
 * This is what makes a quick alert worth keeping as one row: the driver sends
 * the bare alert first, then opens it again and fills in what happened. Only
 * the supplied fields are touched, so a later edit can't blank a photo the
 * first send carried.
 */
async function update(reportId: string, patch: Partial<DriverReport>): Promise<DriverReport> {
  const { data, error } = await supabase
    .from('driver_reports')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('report_id', reportId)
    .select(REPORT_WITH_RELATIONS_SELECT)
    .single()

  if (error) throw error
  return data as unknown as DriverReport
}

export default {
  create,
  findByDriverId,
  findById,
  findAll,
  update,
}
