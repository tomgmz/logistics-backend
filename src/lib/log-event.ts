import { supabase } from './supabase.js'
import { LogType } from '../types/audit-logs.types.js'

export function logEvent(params: {
  user_id?:     string | null
  log_type:     LogType
  action:       string
  description?: string
}): void {
  supabase.from('audit_logs').insert(params).then(({ error }) => {
    if (error) console.error('[logEvent]', error.message)
  })
}