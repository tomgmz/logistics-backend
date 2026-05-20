import { Request, Response } from 'express'
import * as FetchUsersService from '../../services/admin/fetch-user.service.js'

export async function getUsers(req: Request, res: Response) {
  try {
    const { role, status, search, page, limit } = req.query

    console.log('getUsers query:', req.query)

    const result = await FetchUsersService.getUsers({
      role:   role   as string | undefined,
      status: status as 'active' | 'inactive' | 'archived' | undefined,
      search: search as string | undefined,
      page:   page   ? parseInt(page  as string, 10) : undefined,
      limit:  limit  ? parseInt(limit as string, 10) : undefined,
    })

    res.status(200).json({ status: 'success', ...result })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getUserStats(req: Request, res: Response) {
  try {
    const roles = req.query.roles
      ? (req.query.roles as string).split(',').map((r) => r.trim())
      : undefined

    const stats = await FetchUsersService.getUserStats(roles)
    res.status(200).json({ status: 'success', data: stats })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}