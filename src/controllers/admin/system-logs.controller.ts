import { Request, Response } from 'express'
import * as SystemLogService from '../../services/admin/system-logs.service.js'
import { getRequestMeta } from '../../lib/controller-utils.js'
import {
  GetSystemLogIssuesQuery,
  SystemLogIssueAction,
  GetSystemLogsQuery,
  SystemLogEventType,
  SystemLogLevel,
} from '../../types/system-logs.types.js'

/** A YYYY-MM-DD query param, or undefined. */
function dayParam(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Shared by the list and the export so both read the filters the same way.
function queryFrom(req: Request): GetSystemLogsQuery {
  return {
    issue_id:   typeof req.query.issue_id === 'string' && UUID.test(req.query.issue_id) ? req.query.issue_id : undefined,
    event_type: req.query.event_type as SystemLogEventType | undefined,
    log_level:  req.query.log_level  as SystemLogLevel     | undefined,
    // Absent means "both"; only an explicit true/false filters.
    resolved:   req.query.resolved === undefined
                  ? undefined
                  : req.query.resolved === 'true',
    search:     req.query.search as string | undefined,
    // "Select Date": Manila calendar days, YYYY-MM-DD, both ends included.
    from:      dayParam(req.query.from),
    to:        dayParam(req.query.to),
    sort:       (req.query.sort === 'asc' ? 'asc' : 'desc'),
    page:       req.query.page  ? Number(req.query.page)  : 1,
    limit:      req.query.limit ? Number(req.query.limit) : 15,
  }
}

export async function getAllLogs(req: Request, res: Response) {
  try {
    const data = await SystemLogService.getAllLogs(queryFrom(req))
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
    const { rows, truncated } = await SystemLogService.exportLogs(queryFrom(req))
    res.status(200).json({ status: 'success', data: rows, meta: { truncated, count: rows.length } })
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
      getRequestMeta(req).userId ?? null,
    )
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Log not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

// ── Issues ──────────────────────────────────────────────────────────────────

export async function getIssues(req: Request, res: Response) {
  try {
    const status = req.query.status
    const level  = req.query.log_level
    const query: GetSystemLogIssuesQuery = {
      status:     status === 'open' || status === 'resolved' || status === 'ignored' ? status : undefined,
      log_level:  level === 'error' || level === 'critical' ? level : undefined,
      event_type: req.query.event_type as SystemLogEventType | undefined,
      search:     req.query.search as string | undefined,
      sort:       req.query.sort === 'asc' ? 'asc' : 'desc',
      page:       req.query.page  ? Number(req.query.page)  : 1,
      limit:      req.query.limit ? Number(req.query.limit) : 20,
    }
    const data = await SystemLogService.getIssues(query)
    res.status(200).json({ status: 'success', ...data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getIssue(req: Request, res: Response) {
  try {
    if (!UUID.test(String(req.params.id))) throw new Error('Issue not found')
    const data = await SystemLogService.getIssue(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Issue not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

/** PATCH body: { action: 'resolve' | 'reopen' | 'ignore', hours?: 24 | 168 | null } */
export async function actOnIssue(req: Request, res: Response) {
  try {
    if (!UUID.test(String(req.params.id))) throw new Error('Issue not found')
    const action = req.body?.action
    if (action !== 'resolve' && action !== 'reopen' && action !== 'ignore') {
      res.status(400).json({ status: 'error', message: 'Choose resolve, reopen or ignore' })
      return
    }
    const input: SystemLogIssueAction = action === 'ignore'
      ? { action, hours: req.body?.hours == null ? null : Number(req.body.hours) }
      : { action }
    const data = await SystemLogService.actOnIssue(req.params.id as string, input, getRequestMeta(req).userId ?? null)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Issue not found' ? 404 : err.message === 'Choose how long to ignore it' ? 400 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}
