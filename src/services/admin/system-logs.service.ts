import * as SystemLogModel from '../../models/admin/system-logs.model.js'
import { GetSystemLogsQuery } from '../../types/system-logs.types.js'

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
