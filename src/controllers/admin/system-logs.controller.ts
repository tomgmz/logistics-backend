import { Request, Response } from 'express'
import * as SystemLogService from '../../services/admin/system-logs.service.js'
import {
  GetSystemLogsQuery,
  SystemLogEventType,
  SystemLogLevel,
} from '../../types/system-logs.types.js'

export async function getAllLogs(req: Request, res: Response) {
  try {
    const query: GetSystemLogsQuery = {
      event_type: req.query.event_type as SystemLogEventType | undefined,
      log_level:  req.query.log_level  as SystemLogLevel     | undefined,
      // Absent means "both"; only an explicit true/false filters.
      resolved:   req.query.resolved === undefined
                    ? undefined
                    : req.query.resolved === 'true',
      search:     req.query.search as string | undefined,
      sort:       (req.query.sort === 'asc' ? 'asc' : 'desc'),
      page:       req.query.page  ? Number(req.query.page)  : 1,
      limit:      req.query.limit ? Number(req.query.limit) : 15,
    }
    const data = await SystemLogService.getAllLogs(query)
    res.status(200).json({ status: 'success', ...data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getLogById(req: Request, res: Response) {
  try {
    const data = await SystemLogService.getLogById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Log not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function getLogStats(req: Request, res: Response) {
  try {
    const data = await SystemLogService.getLogStats()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function setResolved(req: Request, res: Response) {
  try {
    const data = await SystemLogService.setResolved(
      req.params.id as string,
      req.body?.resolved !== false,
    )
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Log not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}
