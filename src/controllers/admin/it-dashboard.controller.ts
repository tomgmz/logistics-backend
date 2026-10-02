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
