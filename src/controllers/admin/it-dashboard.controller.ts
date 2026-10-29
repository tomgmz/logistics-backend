import { Request, Response } from 'express'
import * as ItDashboardService from '../../services/admin/it-dashboard.service.js'

/**
 * Deliberately does not write a system log on failure. The dashboard re-reads
 * when system_logs changes; a failed read that logged itself would trigger the
 * next read, and so on.
 */
export async function getSummary(_req: Request, res: Response) {
  try {
    const data = await ItDashboardService.getSummary()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    console.error('[it-dashboard] summary failed:', err?.message ?? err)
    res.status(500).json({ status: 'error', message: err?.message ?? 'Failed to load the dashboard' })
  }
}

const RANGES = ['12m', '30d', '7d', '24h'] as const
const LEVELS = ['critical', 'error', 'warn'] as const

/** GET /admin/it-dashboard/trend?range=30d&level=error — the dashboard's chart. */
export async function getTrend(req: Request, res: Response) {
  const range = String(req.query.range ?? '30d')
  const level = String(req.query.level ?? 'error')
  if (!(RANGES as readonly string[]).includes(range) || !(LEVELS as readonly string[]).includes(level)) {
    res.status(400).json({ status: 'error', message: 'range must be 12m, 30d, 7d or 24h; level must be critical, error or warn' })
    return
  }
  try {
    const data = await ItDashboardService.getTrend(range as typeof RANGES[number], level as typeof LEVELS[number])
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    console.error('[it-dashboard] trend failed:', err?.message ?? err)
    res.status(500).json({ status: 'error', message: err?.message ?? 'Failed to load the chart' })
  }
}
