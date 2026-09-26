import { Request, Response } from 'express'
import * as AuditLogService from '../../services/admin/audit-logs.service.js'
import { GetLogsQuery, LogType } from '../../types/audit-logs.types.js'

// Shared by the list and the export so both read the filters the same way.
function queryFrom(req: Request): GetLogsQuery {
  return {
    log_type:  req.query.log_type as LogType | undefined,
    search:    req.query.search   as string  | undefined,
    sort:      (req.query.sort === 'asc' ? 'asc' : 'desc'),
    page:      req.query.page  ? Number(req.query.page)  : 1,
    limit:     req.query.limit ? Number(req.query.limit) : 20,
  }
}

export async function getAllLogs(req: Request, res: Response) {
  try {
    const data = await AuditLogService.getAllLogs(queryFrom(req))
    res.status(200).json({ status: 'success', ...data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

/**
 * Returns rows, not a file — the Next proxy re-serialises every response with
 * NextResponse.json, so the browser builds the .xlsx.
 */
export async function exportLogs(req: Request, res: Response) {
  try {
    const { rows, truncated } = await AuditLogService.exportLogs(queryFrom(req))
    res.status(200).json({ status: 'success', data: rows, meta: { truncated, count: rows.length } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getLogById(req: Request, res: Response) {
  try {
    const data = await AuditLogService.getLogById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Log not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function getLogStats(req: Request, res: Response) {
  try {
    const data = await AuditLogService.getLogStats()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
