import { Request, Response } from 'express'
import * as SystemLogService from '../../services/admin/system-logs.service.js'
import { GetLogsQuery, LogType } from '../../types/system-logs.types.js'

export async function getAllLogs(req: Request, res: Response) {
  try {
    const query: GetLogsQuery = {
      log_type:  req.query.log_type as LogType | undefined,
      search:    req.query.search   as string  | undefined,
      sort:      (req.query.sort === 'asc' ? 'asc' : 'desc'),
      page:      req.query.page  ? Number(req.query.page)  : 1,
      limit:     req.query.limit ? Number(req.query.limit) : 20,
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