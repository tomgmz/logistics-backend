import * as AuditLogModel from '../../models/admin/audit-logs.model.js'
import { GetLogsQuery } from '../../types/audit-logs.types.js'

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
