import * as SystemLogModel from '../../models/admin/system-logs.model.js'
import { GetLogsQuery } from '../../types/system-logs.types.js'

export async function getAllLogs(query: GetLogsQuery) {
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
