import { supabase } from '../../lib/supabase.js'

/** One in-app emergency call. See the 20261023000000_emergency_calls migration. */

export type EmergencyCallStatus = 'ringing' | 'answered' | 'ended' | 'missed' | 'fell_back'

export interface EmergencyCall {
  call_id:       string
  report_id:     string | null
  driver_id:     string
  booking_id:    string | null
  room_name:     string
  status:        EmergencyCallStatus
  rung_user_ids: string[]
  answered_by:   string | null
  answered_at:   string | null
  ended_by:      string | null
  ended_at:      string | null
  end_reason:    string | null
  created_at:    string
}

async function create(input: {
  report_id:     string | null
  driver_id:     string
  booking_id:    string | null
  room_name:     string
  rung_user_ids: string[]
}): Promise<EmergencyCall> {
  const { data, error } = await supabase
    .from('emergency_calls')
    .insert(input)
    .select('*')
    .single()

  if (error) throw error
  return data as EmergencyCall
}

async function findById(callId: string): Promise<EmergencyCall | null> {
  const { data, error } = await supabase
    .from('emergency_calls')
    .select('*')
    .eq('call_id', callId)
    .maybeSingle()

  if (error) throw error
  return (data as EmergencyCall | null) ?? null
}

/**
 * Claim a ringing call for one manager. Conditional on the status, so of two
 * managers who press Answer together exactly one gets the row back.
 */
async function claim(callId: string, userId: string): Promise<EmergencyCall | null> {
  const { data, error } = await supabase
    .from('emergency_calls')
    .update({ status: 'answered', answered_by: userId, answered_at: new Date().toISOString() })
    .eq('call_id', callId)
    .eq('status', 'ringing')
    .select('*')
    .maybeSingle()

  if (error) throw error
  return (data as EmergencyCall | null) ?? null
}

/**
 * Close a call that is still in one of `from` (ringing or live by default).
 * Null when it was already closed or in another state.
 */
async function close(
  callId: string,
  status: Extract<EmergencyCallStatus, 'ended' | 'missed' | 'fell_back'>,
  reason: string,
  endedBy: string | null,
  from: EmergencyCallStatus[] = ['ringing', 'answered'],
): Promise<EmergencyCall | null> {
  const { data, error } = await supabase
    .from('emergency_calls')
    .update({ status, end_reason: reason, ended_by: endedBy, ended_at: new Date().toISOString() })
    .eq('call_id', callId)
    .in('status', from)
    .select('*')
    .maybeSingle()

  if (error) throw error
  return (data as EmergencyCall | null) ?? null
}

/** Calls still ringing for this user and placed after `since`. */
async function findRingingFor(userId: string, since: Date): Promise<EmergencyCall[]> {
  const { data, error } = await supabase
    .from('emergency_calls')
    .select('*')
    .eq('status', 'ringing')
    .contains('rung_user_ids', [userId])
    .gt('created_at', since.toISOString())
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as EmergencyCall[]
}

export default { create, findById, claim, close, findRingingFor }
