import * as AuditLogModel from '../../models/admin/audit-logs.model.js'
import { GetLogsQuery } from '../../types/audit-logs.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllLogs(query: GetLogsQuery) {
  return AuditLogModel.findAll(query)
}

export async function getLogById(logId: string) {
  const log = await AuditLogModel.findById(logId)
  if (!log) throw new Error('Log not found')
  return log
}

export async function getLogStats() {
  return AuditLogModel.getStats()
}

export const AUDIT_EXPORT_ROW_CAP = 10000

/**
 * Rows for an Excel export of the audit trail. The file itself is built in the
 * browser: the Next proxy re-serialises every response as JSON, so a binary
 * body would not survive the trip.
 */
export async function exportLogs(query: GetLogsQuery) {
  // One past the cap, so a full read tells us there was more behind it.
  const rows      = await AuditLogModel.findForExport(query, AUDIT_EXPORT_ROW_CAP + 1)
  const truncated = rows.length > AUDIT_EXPORT_ROW_CAP
  const exported  = truncated ? AUDIT_EXPORT_ROW_CAP : rows.length

  const { log_type, search, sort } = query
  // The audit trail leaving the system is itself an auditable event. The actor
  // comes from the ambient request context.
  logEvent({
    log_type:    'data_export',
    action:      'audit_logs_exported',
    description: `Exported ${exported} audit log row(s)${truncated ? ` (capped at ${AUDIT_EXPORT_ROW_CAP})` : ''}; filters: ${JSON.stringify({ log_type, search, sort })}`,
  })

  return { rows: truncated ? rows.slice(0, AUDIT_EXPORT_ROW_CAP) : rows, truncated }
}
