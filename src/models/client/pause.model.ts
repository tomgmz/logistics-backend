import { supabase } from '../../lib/supabase.js'
import type {
  BookingPause,
  BookingPauseWithActors,
  PauseReason,
  ResumedVia,
} from '../../types/client/pause.types.js'

/**
 * Pauses on a delivery. The history lives in booking_pauses; the pause in force
 * is mirrored onto the bookings row so every booking list shows it (see the
 * 20261016000000_trip_pauses migration).
 */

const WITH_ACTORS_SELECT = `
  *,
  pauser:users!booking_pauses_paused_by_fkey ( first_name, last_name ),
  resumer:users!booking_pauses_resumed_by_fkey ( first_name, last_name )
`

/** The pause in force on this booking, or null when the truck is moving. */
async function findOpen(bookingId: string): Promise<BookingPause | null> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .select('*')
    .eq('booking_id', bookingId)
    .is('resumed_at', null)
    .maybeSingle()

  if (error) throw error
  return (data ?? null) as BookingPause | null
}

/** Every pause on the booking, newest first, for the staff timeline. */
async function findByBookingId(bookingId: string): Promise<BookingPauseWithActors[]> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .select(WITH_ACTORS_SELECT)
    .eq('booking_id', bookingId)
    .order('paused_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as unknown as BookingPauseWithActors[]
}

/**
 * Open a pause. Returns null when one is already open — the unique index on
 * open pauses turns a second, racing insert (a retry from the offline queue)
 * into that, rather than into an error.
 */
async function open(fields: {
  booking_id:  string
  trip_id:     string | null
  reason:      PauseReason
  note:        string
  paused_by:   string | null
  paused_at:   string
  latitude:    number | null
  longitude:   number | null
  accuracy_m:  number | null
}): Promise<BookingPause | null> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .insert(fields)
    .select('*')
    .single()

  if (error) {
    if ((error as { code?: string }).code === '23505') return null
    throw error
  }
  return data as BookingPause
}

async function linkReport(pauseId: string, reportId: string): Promise<void> {
  const { error } = await supabase
    .from('booking_pauses')
    .update({ report_id: reportId })
    .eq('pause_id', pauseId)
  if (error) throw error
}

/**
 * Close a pause. True only for the call that actually closed it: the driver and
 * the office can end the same pause at the same instant, both having read it as
 * open, and only one of them should announce it.
 */
async function close(pauseId: string, fields: {
  resumed_at:  string
  resumed_by:  string | null
  resumed_via: ResumedVia
  resume_note: string | null
}): Promise<boolean> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .update(fields)
    .eq('pause_id', pauseId)
    .is('resumed_at', null)
    .select('pause_id')
  if (error) throw error
  return (data ?? []).length > 0
}

/** The expected continuation of an open pause. Null when the pause had already ended. */
async function setExpectedResume(pauseId: string, fields: {
  expected_resume_date:      string
  expected_resume_call_time: string
  expected_resume_set_by:    string | null
}): Promise<BookingPause | null> {
  const { data, error } = await supabase
    .from('booking_pauses')
    .update({ ...fields, expected_resume_set_at: new Date().toISOString() })
    .eq('pause_id', pauseId)
    .is('resumed_at', null)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return (data as BookingPause | null) ?? null
}

/** Mirror the pause in force onto the booking, or clear it (all nulls). */
async function setBookingPause(bookingId: string, pause: {
  paused_at:    string | null
  pause_reason: PauseReason | null
  pause_note:   string | null
}): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .update({ ...pause, updated_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
  if (error) throw error
}

export const PauseModel = {
  findOpen,
  findByBookingId,
  open,
  linkReport,
  close,
  setExpectedResume,
  setBookingPause,
}

export default PauseModel
