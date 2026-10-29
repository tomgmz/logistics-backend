import { Request, Response } from 'express'
import { getRequestMeta } from '../../lib/controller-utils.js'
import * as FetchUsersService from '../../services/admin/fetch-user.service.js'
import * as UserDirectory from '../../services/admin/user-directory.service.js'
import { pageQuery, paginate, MAX_PAGE_LIMIT } from '../../lib/paginate.js'

export async function getUsers(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const { role, status, search, page, limit } = req.query

    const result = await FetchUsersService.getUsers({
      role:      role   as string | undefined,
      status:    status as string | undefined,
      search:    search as string | undefined,
      page:      page   ? parseInt(page  as string, 10) : undefined,
      limit:     limit  ? parseInt(limit as string, 10) : undefined,
      excludeId: userId ?? undefined,
    })

    res.status(200).json({ status: 'success', ...result })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getUserStats(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const roles = req.query.roles
      ? (req.query.roles as string).split(',').map((r) => r.trim())
      : undefined

    const stats = await FetchUsersService.getUserStats(roles, userId ?? undefined)
    res.status(200).json({ status: 'success', data: stats })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
/**
 * User Management's tables, one page at a time:
 * GET /admin/user-directory?tab=clients&filters=[...]&search=&page=1&limit=20
 * (see services/admin/user-directory.service.ts for the rules).
 */
export async function getUserDirectory(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const tab = String(req.query.tab ?? 'all') as UserDirectory.DirectoryTab
    if (!UserDirectory.DIRECTORY_TABS.includes(tab)) {
      return res.status(400).json({ status: 'error', message: 'Unknown tab' })
    }
    const { rows, licenseFlagCount } = await UserDirectory.listDirectory({
      tab,
      filters:   UserDirectory.parseFilterRules(req.query.filters),
      search:    typeof req.query.search === 'string' ? req.query.search.trim() : '',
      excludeId: userId ?? undefined,
    })
    const { data, meta } = paginate(rows, pageQuery(req) ?? { page: 1, limit: MAX_PAGE_LIMIT })
    res.status(200).json({ status: 'success', data, meta: { ...meta, licenseFlagCount } })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}
