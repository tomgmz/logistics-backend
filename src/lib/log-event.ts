import { supabase } from './supabase.js'
import { LogType } from '../types/audit-logs.types.js'
import { getRequestContext } from './request-context.js'
import { logSystem } from './log-system.js'

/**
 * Writes one row to the business audit trail: a person did something to a
 * business record. If there is no human actor, or the row is only interesting
 * while something is broken, it belongs in logSystem() instead.
 *
 * Fire-and-forget by design — an audit write must never fail the operation it
 * is describing. A failure here is itself a system-log event, so a broken audit
 * trail is visible rather than silent (it used to go to console.error only,
 * which meant it vanished on the next restart).
 */
export function logEvent(params: {
  user_id?:     string | null
  log_type:     LogType
  action:       string
  description?: string
}): void {
  const ctx = getRequestContext()

  const row = {
    ...params,
    // Explicit actor wins; otherwise take it from the ambient request, if any.
    user_id:    params.user_id    ?? ctx?.userId ?? null,
  }

  supabase.from('audit_logs').insert(row).then(({ error }) => {
    if (error) {
      console.error('[logEvent]', error.message)
      logSystem({
        log_level:  'error',
        event_type: 'db_event',
        source:     'log-event',
        message:    `Audit log write failed: ${error.message}`,
        metadata:   { attempted_action: params.action, attempted_type: params.log_type },
      })
    }
  })
}

export default logEvent
