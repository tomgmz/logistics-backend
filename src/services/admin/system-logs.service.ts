import * as SystemLogModel from '../../models/admin/system-logs.model.js'
import { GetSystemLogsQuery } from '../../types/system-logs.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllLogs(query: GetSystemLogsQuery) {
  return SystemLogModel.findAll(query)
}

export async function getLogById(logId: string) {
  const log = await SystemLogModel.findById(logId)
  if (!log) throw new Error('Log not found')
  return log
}

export async function getLogStats() {
  return SystemLogModel.getStats()
}

/**
 * Triage. System logs are a work queue, which is the other thing that separates
 * them from audit rows — those are history and cannot be "handled".
 */
export async function setResolved(logId: string, resolved: boolean) {
  const updated = await SystemLogModel.setResolved(logId, resolved)
  if (!updated) throw new Error('Log not found')
  return updated
}

export const SYSTEM_EXPORT_ROW_CAP = 10000

/**
 * Rows for an Excel export of the system log. The file itself is built in the
 * browser: the Next proxy re-serialises every response as JSON, so a binary
 * body would not survive the trip.
 */
export async function exportLogs(query: GetSystemLogsQuery) {
  // One past the cap, so a full read tells us there was more behind it.
  const rows      = await SystemLogModel.findForExport(query, SYSTEM_EXPORT_ROW_CAP + 1)
  const truncated = rows.length > SYSTEM_EXPORT_ROW_CAP
  const exported  = truncated ? SYSTEM_EXPORT_ROW_CAP : rows.length

  // Audit, not system: a person took records out of the system in bulk, and
  // these carry stack traces and provider internals.
  const { event_type, log_level, resolved, search, sort } = query
  logEvent({
    log_type:    'data_export',
    action:      'system_logs_exported',
    description: `Exported ${exported} system log row(s)${truncated ? ` (capped at ${SYSTEM_EXPORT_ROW_CAP})` : ''}; filters: ${JSON.stringify({ event_type, log_level, resolved, search, sort })}`,
  })

  return { rows: truncated ? rows.slice(0, SYSTEM_EXPORT_ROW_CAP) : rows, truncated }
}
