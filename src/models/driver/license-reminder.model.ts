import { supabase } from '../../lib/supabase.js'

/** A driver whose license expires inside the reminder window. */
export interface LicenseReminderCandidate {
  driver_id:       string
  user_id:         string
  license_number:  string | null
  license_expiry:  string
  license_reminder_notified_for: string | null
  license_reminder_emailed_for:  string | null
  /** "<expiry>|<stage>|<channel>" → when sent (the stages after the first month). */
  license_reminders: Record<string, string>
  email:           string | null
  first_name:      string | null
  last_name:       string | null
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
      license_reminder_notified_for, license_reminder_emailed_for, license_reminders,
      users!drivers_user_id_fkey!inner ( email, first_name, last_name, status, role )
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
      license_reminders: (row.license_reminders ?? {}) as Record<string, string>,
      email:          user?.email ?? null,
      first_name:     user?.first_name ?? null,
      last_name:      user?.last_name ?? null,
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

/** Record one stage + channel as sent for this expiry date (read-modify-write; one pass runs at a time). */
export async function markStage(driverId: string, key: string): Promise<void> {
  const { data, error } = await supabase.from('drivers').select('license_reminders').eq('driver_id', driverId).maybeSingle()
  if (error) throw error
  const next = { ...((data?.license_reminders ?? {}) as Record<string, string>), [key]: new Date().toISOString() }
  const { error: upErr } = await supabase.from('drivers').update({ license_reminders: next }).eq('driver_id', driverId)
  if (upErr) throw upErr
}

/** The office told in the app: every active Company Administrator and Operations Manager. */
export async function findOfficeRecipients(): Promise<Array<{ user_id: string; role: string }>> {
  const { data, error } = await supabase
    .from('users')
    .select('user_id, role')
    .in('role', ['admin', 'operations_manager'])
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []) as Array<{ user_id: string; role: string }>
}
