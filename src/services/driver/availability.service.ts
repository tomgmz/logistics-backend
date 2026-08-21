import { supabase } from '../../lib/supabase.js'
import { logEvent } from '../../lib/log-event.js'

/**
 * The driver's own on/off switch for delivery work.
 *
 * A driver account starts 'unavailable' — nobody is put in the assignable pool
 * without opting in. From the app the driver flips to 'available' when they are
 * ready to take an assignment and back to 'unavailable' when they are not.
 *
 * 'assigned' is system-owned: it is set when operations gives them a booking and
 * cleared when the delivery finishes. The driver cannot toggle out of it — they
 * have to finish (or be re-assigned off) the delivery first.
 */

export type DriverAvailability = 'available' | 'unavailable'

export interface DriverAvailabilityState {
  driver_id: string
  status:    string
  // Whether the toggle is actionable right now (false while out on a delivery).
  can_toggle: boolean
}

async function findDriverByUser(userId: string): Promise<{ driver_id: string; status: string }> {
  const { data, error } = await supabase
    .from('drivers')
    .select('driver_id, status')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('No driver profile found for this account')
  return data as { driver_id: string; status: string }
}

export async function getAvailability(userId: string): Promise<DriverAvailabilityState> {
  const driver = await findDriverByUser(userId)
  return {
    driver_id:  driver.driver_id,
    status:     driver.status,
    can_toggle: driver.status !== 'assigned',
  }
}

export async function setAvailability(
  userId: string,
  status: DriverAvailability,
): Promise<DriverAvailabilityState> {
  const driver = await findDriverByUser(userId)

  if (driver.status === 'assigned') {
    throw new Error('You are on an active delivery — finish it before changing your availability')
  }
  if (driver.status === 'on_leave' || driver.status === 'inactive') {
    throw new Error(`Your account is marked '${driver.status}' — contact the fleet manager to be reinstated`)
  }

  if (driver.status !== status) {
    const { error } = await supabase
      .from('drivers')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('driver_id', driver.driver_id)
    if (error) throw error

    logEvent({
      user_id:     userId,
      log_type:    'user_activity',
      action:      status === 'available' ? 'driver_marked_available' : 'driver_marked_unavailable',
      description: `Driver ${driver.driver_id} is now ${status} for delivery assignments`,
    })
  }

  return { driver_id: driver.driver_id, status, can_toggle: true }
}
