import { Request, Response } from 'express'
import * as ItDashboardService from '../../services/admin/it-dashboard.service.js'
import * as ItLogistics from '../../services/admin/it-logistics.service.js'

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

// ── Logistics view (TailAdmin logistics layout, 2026-11-26) ─────────────────


const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** GET /admin/it-dashboard/logistics?period=monthly|annually — cards, chart, tracked delivery. */
export async function getLogistics(req: Request, res: Response) {
  const period = String(req.query.period ?? 'monthly') as ItLogistics.Period
  if (!ItLogistics.PERIODS.includes(period)) {
    res.status(400).json({ status: 'error', message: 'period must be monthly or annually' })
    return
  }
  try {
    const data = await ItLogistics.getOverview(period)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    console.error('[it-dashboard] logistics failed:', err?.message ?? err)
    res.status(500).json({ status: 'error', message: 'Failed to load the dashboard' })
  }
}

/** GET /admin/it-dashboard/activities?tab=all&search=&date_from=&date_to=&page=1&limit=20 */
export async function getActivities(req: Request, res: Response) {
  const tab = String(req.query.tab ?? 'all') as ItLogistics.ActivityTab
  const from = String(req.query.date_from ?? '')
  const to   = String(req.query.date_to ?? '')
  if (!ItLogistics.ACTIVITY_TABS.includes(tab) || (from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) {
    res.status(400).json({ status: 'error', message: 'Invalid tab or date' })
    return
  }
  try {
    const result = await ItLogistics.listActivities({
      tab,
      search:   String(req.query.search ?? '').slice(0, 100),
      dateFrom: from || null,
      dateTo:   to || null,
      page:     Number(req.query.page) || 1,
      limit:    Number(req.query.limit) || 20,
    })
    res.status(200).json({ status: 'success', ...result })
  } catch (err: any) {
    console.error('[it-dashboard] activities failed:', err?.message ?? err)
    res.status(500).json({ status: 'error', message: 'Failed to load deliveries' })
  }
}
