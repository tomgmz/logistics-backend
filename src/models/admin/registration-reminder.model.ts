import { supabase } from '../../lib/supabase.js'

/** A vehicle whose registration expires inside the reminder window. */
export interface RegistrationReminderCandidate {
  truck_id:            string
  plate_number:        string
  registration_expiry: string
  registration_reminder_notified_for: string | null
  registration_reminder_emailed_for:  string | null
}

/** Someone the company-side reminder goes to. */
export interface RegistrationReminderRecipient {
  user_id:    string
  role:       string
  email:      string | null
  first_name: string | null
}

/**
 * Vehicles whose registration expires between `fromDay` and `toDay` (inclusive,
 * `YYYY-MM-DD`). Archived and inactive vehicles are parked and left out.
 *
 * Returns every candidate in the window, reminded or not; the scheduler compares
 * the stamps against registration_expiry itself, because "already sent" means
 * "sent for THIS expiry date" and PostgREST cannot compare two columns.
 */
export async function findExpiringBetween(fromDay: string, toDay: string): Promise<RegistrationReminderCandidate[]> {
  const { data, error } = await supabase
    .from('trucks')
    .select(`
      truck_id, plate_number, registration_expiry,
      registration_reminder_notified_for, registration_reminder_emailed_for
    `)
    .not('registration_expiry', 'is', null)
    .gte('registration_expiry', fromDay)
    .lte('registration_expiry', toDay)
    .not('status', 'in', '(archived,inactive)')

  if (error) throw error

  return (data ?? []).map((row: any) => ({
    truck_id:            row.truck_id,
    plate_number:        row.plate_number,
    registration_expiry: String(row.registration_expiry).slice(0, 10),
    registration_reminder_notified_for: row.registration_reminder_notified_for ?? null,
    registration_reminder_emailed_for:  row.registration_reminder_emailed_for ?? null,
  }))
}

/**
 * The people who keep the fleet road-legal: every active Fleet Manager and
 * Company Administrator.
 */
export async function findRecipients(): Promise<RegistrationReminderRecipient[]> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role, email, first_name')
    .in('role', ['fleet_manager', 'admin'])
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []) as RegistrationReminderRecipient[]
}

/** Record which expiry date a channel's reminder went out for. */
export async function markReminded(
  truckId: string,
  channel: 'notified' | 'emailed',
  expiry:  string,
): Promise<void> {
  const column = channel === 'notified' ? 'registration_reminder_notified_for' : 'registration_reminder_emailed_for'
  const { error } = await supabase
    .from('trucks')
    .update({ [column]: expiry })
    .eq('truck_id', truckId)
  if (error) throw error
}
