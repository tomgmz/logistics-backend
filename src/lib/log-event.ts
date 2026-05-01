import { supabase } from './supabase.js'
import { LogType } from '../types/system-logs.types.js'

export function logEvent(params: {
  user_id?:     string | null
  log_type:     LogType
  action:       string
  description?: string
  ip_address?:  string | null
}): void {
  supabase.from('system_logs').insert(params).then(({ error }) => {
    if (error) console.error('[logEvent]', error.message)
  })
}