import { supabase } from '../../lib/supabase.js'

/** A driver whose license expires inside the reminder window. */
export interface LicenseReminderCandidate {
  driver_id:       string
  user_id:         string
  license_number:  string | null
  license_expiry:  string
  license_reminder_notified_for: string | null
  license_reminder_emailed_for:  string | null
  email:           string | null
  first_name:      string | null
}

/**
 * Active drivers whose license expires between `fromDay` and `toDay` (inclusive,
 * `YYYY-MM-DD`). Archived and deactivated accounts are left out: nobody can
 * sign in to read the notification, and an archived driver is no longer ours to
 * remind.
 *
 * Returns every candidate in the window, reminded or not; the scheduler compares
 * the stamps against license_expiry itself, because "already sent" means "sent
 * for THIS expiry date" and PostgREST cannot compare two columns.
 */
export async function findExpiringBetween(fromDay: string, toDay: string): Promise<LicenseReminderCandidate[]> {
  const { data, error } = await supabase
    .from('drivers')
    .select(`
      driver_id, user_id, license_number, license_expiry,
      license_reminder_notified_for, license_reminder_emailed_for,
      users!inner ( email, first_name, status, role )
    `)
    .not('license_expiry', 'is', null)
    .gte('license_expiry', fromDay)
    .lte('license_expiry', toDay)
    .eq('users.status', 'active')
    .eq('users.role', 'driver')

  if (error) throw error

  return (data ?? []).map((row: any) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users
    return {
      driver_id:      row.driver_id,
      user_id:        row.user_id,
      license_number: row.license_number ?? null,
      license_expiry: String(row.license_expiry).slice(0, 10),
      license_reminder_notified_for: row.license_reminder_notified_for ?? null,
      license_reminder_emailed_for:  row.license_reminder_emailed_for ?? null,
      email:          user?.email ?? null,
      first_name:     user?.first_name ?? null,
    }
  })
}

/** Record which expiry date a channel's reminder went out for. */
export async function markReminded(
  driverId: string,
  channel:  'notified' | 'emailed',
  expiry:   string,
): Promise<void> {
  const column = channel === 'notified' ? 'license_reminder_notified_for' : 'license_reminder_emailed_for'
  const { error } = await supabase
    .from('drivers')
    .update({ [column]: expiry })
    .eq('driver_id', driverId)
  if (error) throw error
}
