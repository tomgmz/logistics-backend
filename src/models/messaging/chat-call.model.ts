import { supabase } from '../../lib/supabase.js'

/** One in-app call from a direct conversation. See the 20261024040000_chat_calls migration. */

export type ChatCallStatus = 'ringing' | 'answered' | 'ended' | 'missed' | 'declined'

export interface ChatCall {
  call_id:         string
  conversation_id: string
  caller_id:       string
  callee_id:       string
  room_name:       string
  status:          ChatCallStatus
  answered_at:     string | null
  ended_by:        string | null
  ended_at:        string | null
  end_reason:      string | null
  created_at:      string
}

async function create(input: {
  conversation_id: string
  caller_id:       string
  callee_id:       string
  room_name:       string
}): Promise<ChatCall> {
  const { data, error } = await supabase
    .from('chat_calls')
    .insert(input)
    .select('*')
    .single()

  if (error) throw error
  return data as ChatCall
}

async function findById(callId: string): Promise<ChatCall | null> {
  const { data, error } = await supabase
    .from('chat_calls')
    .select('*')
    .eq('call_id', callId)
    .maybeSingle()

  if (error) throw error
  return (data as ChatCall | null) ?? null
}

/** Answer a ringing call. Conditional on the status, so a cancelled call can't be picked up. */
async function claim(callId: string): Promise<ChatCall | null> {
  const { data, error } = await supabase
    .from('chat_calls')
    .update({ status: 'answered', answered_at: new Date().toISOString() })
    .eq('call_id', callId)
    .eq('status', 'ringing')
    .select('*')
    .maybeSingle()

  if (error) throw error
  return (data as ChatCall | null) ?? null
}

/**
 * Close a call that is still in one of `from` (ringing or live by default).
 * Null when it was already closed or in another state.
 */
async function close(
  callId: string,
  status: Extract<ChatCallStatus, 'ended' | 'missed' | 'declined'>,
  reason: string,
  endedBy: string | null,
  from: ChatCallStatus[] = ['ringing', 'answered'],
): Promise<ChatCall | null> {
  const { data, error } = await supabase
    .from('chat_calls')
    .update({ status, end_reason: reason, ended_by: endedBy, ended_at: new Date().toISOString() })
    .eq('call_id', callId)
    .in('status', from)
    .select('*')
    .maybeSingle()

  if (error) throw error
  return (data as ChatCall | null) ?? null
}

/** Calls still ringing for this callee and placed after `since`. */
async function findRingingFor(userId: string, since: Date): Promise<ChatCall[]> {
  const { data, error } = await supabase
    .from('chat_calls')
    .select('*')
    .eq('status', 'ringing')
    .eq('callee_id', userId)
    .gt('created_at', since.toISOString())
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as ChatCall[]
}

/** Every call this user is on, at either end, that is still ringing or live. */
async function findOpenFor(userId: string): Promise<ChatCall[]> {
  const { data, error } = await supabase
    .from('chat_calls')
    .select('*')
    .in('status', ['ringing', 'answered'])
    .or(`caller_id.eq.${userId},callee_id.eq.${userId}`)

  if (error) throw error
  return (data ?? []) as ChatCall[]
}

export default { create, findById, claim, close, findRingingFor, findOpenFor }
