import { Request, Response } from 'express'
import * as StaffDashboardService from '../../services/admin/staff-dashboard.service.js'

export async function getSummary(_req: Request, res: Response) {
  try {
    const data = await StaffDashboardService.getStaffDashboard()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    console.error('[staff-dashboard] summary failed:', err?.message ?? err)
    res.status(500).json({ status: 'error', message: err?.message ?? 'Failed to load the dashboard' })
  }
}
