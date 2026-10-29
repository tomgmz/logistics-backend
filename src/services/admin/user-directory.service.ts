import * as ClientService from './client.service.js'
import * as DriverService from './driver.service.js'
import * as FetchUsersService from './fetch-user.service.js'
import * as EnrollmentService from '../auth/driver-enrollment.service.js'
import * as AdminService from './admin.service.js'
import * as GeneralManagerService from './general_manager.service.js'
import * as FleetAdminService from './fleet_admin.service.js'
import * as OperationsAdminService from './operations_admin.service.js'
import { phDay, phDayPlusMonth } from '../../lib/ph-date.js'
import { matchesWords } from '../../lib/paginate.js'
import { splitRules, matchesFilter, allowedValues, parseFilterRules, type FilterRule } from '../../lib/filter-rules.js'

export { parseFilterRules }

/**
 * User Management's tables (All, Clients, Company Drivers, Vendor Drivers),
 * built, filtered and searched on the server so the browser receives one page.
 *
 * The rules are the ones the page used to apply itself:
 *   - Filters arrive as the Filters panel's rules, [{ field, op: 'is'|'is_not', value }].
 *     Rules on one field: any "is" matches, every "is not" must hold.
 *   - Archived is a status like the rest. The per-role lists hide archived
 *     accounts, so the Status filter decides whether the archived list (from
 *     /users?status=archived) is read instead of, or as well as, the current one.
 *   - The All tab filters role and status in SQL and searches there too.
 *
 * The IT Administrator's Administrator Management uses the same endpoint with
 * the staff tabs (all-admins, admins, general-managers, fleet-admins,
 * operations-admins). There the Status dropdown is one status or none, and none
 * means every status, archived included.
 */

type PeopleTab = 'all' | 'clients' | 'drivers' | 'vendor-drivers'
type StaffTab  = 'admins' | 'general-managers' | 'fleet-admins' | 'operations-admins'
export type DirectoryTab = PeopleTab | StaffTab | 'all-admins'
export const DIRECTORY_TABS: DirectoryTab[] = [
  'all', 'clients', 'drivers', 'vendor-drivers',
  'all-admins', 'admins', 'general-managers', 'fleet-admins', 'operations-admins',
]

const STAFF_ROLES = 'admin,general_manager,fleet_manager,operations_manager'
const STAFF_ROLE: Record<StaffTab, string> = {
  admins:              'admin',
  'general-managers':  'general_manager',
  'fleet-admins':      'fleet_manager',
  'operations-admins': 'operations_manager',
}

async function staffRows(tab: StaffTab): Promise<any[]> {
  switch (tab) {
    case 'admins':            return AdminService.getAllAdmin() as Promise<any[]>
    case 'general-managers':  return GeneralManagerService.getAllGeneralManagers() as Promise<any[]>
    case 'fleet-admins':      return FleetAdminService.getAllFleetAdmins() as Promise<any[]>
    case 'operations-admins': return OperationsAdminService.getAllOperationsAdmins() as Promise<any[]>
  }
}

/** Administrator Management: the staff tabs. */
async function listStaff(
  tab: StaffTab | 'all-admins',
  filters: FilterRule[],
  search: string,
  excludeId?: string,
): Promise<any[]> {
  const pick = split(filters, 'status').is[0] ?? null
  if (tab === 'all-admins') {
    const { data } = await FetchUsersService.getUsers({
      role:   STAFF_ROLES,
      status: pick ?? [...CURRENT_STATUSES, 'archived'].join(','),
      excludeId,
    })
    return data.filter((u: any) => matchesWords(search, staffSearchFields(u)))
  }
  const archived = () => FetchUsersService.getUsers({ role: STAFF_ROLE[tab], status: 'archived', excludeId }).then((r) => r.data)
  const all =
    pick === 'archived' ? await archived()
    // One current status: the role's list (archived accounts are not in it), narrowed.
    : pick ? (await staffRows(tab)).filter((u) => u.status === pick)
    // None picked: current and archived together.
    : (await Promise.all([staffRows(tab), archived()])).flat()
  return all.filter((u) => matchesWords(search, staffSearchFields(u)))
}

/**
 * What each search box names, and only that. Administrators: "Search name,
 * email or phone". Clients and drivers: "Search name, email, phone or
 * company" (the client's company; a vendor driver's vendor).
 */
function staffSearchFields(u: any) {
  return [u.first_name, u.middle_name, u.last_name, u.email, u.phone]
}
function peopleSearchFields(u: any) {
  const one = (v: any) => (Array.isArray(v) ? v[0] : v)
  return [...staffSearchFields(u), one(u.clients)?.company_name, one(u.drivers)?.vendor_name]
}

const CURRENT_STATUSES = ['active', 'inactive', 'deactivated', 'permanently_locked']

const split = splitRules

/** Expired, or expiring within a calendar month (Philippine time) — the driver reminder's window. */
export function needsLicenseUpdate(expiry: unknown): boolean {
  const day = typeof expiry === 'string' && /^\d{4}-\d{2}-\d{2}/.test(expiry) ? expiry.slice(0, 10) : null
  if (!day) return false
  const today = phDay()
  return day < today || day <= phDayPlusMonth()
}

/** The states the App Access badge draws. */
function accessState(access: any): string | null {
  if (!access) return null
  if (!access.account_active) return 'revoked'
  if (access.enrolled)        return 'enrolled'
  return access.invite_pending ? 'invited' : 'not_set_up'
}

const ARCHIVED_ROLE: Record<Exclude<PeopleTab, 'all'>, string> = {
  clients:          'client',
  drivers:          'driver',
  'vendor-drivers': 'driver',
}

async function currentRows(tab: Exclude<PeopleTab, 'all'>): Promise<any[]> {
  switch (tab) {
    case 'clients':        return ClientService.getAllClient() as Promise<any[]>
    case 'drivers':        return DriverService.getAllDrivers() as Promise<any[]>
    case 'vendor-drivers': return EnrollmentService.listExternalDrivers() as Promise<any[]>
  }
}

async function archivedRows(tab: Exclude<PeopleTab, 'all'>, excludeId?: string): Promise<any[]> {
  const { data } = await FetchUsersService.getUsers({ role: ARCHIVED_ROLE[tab], status: 'archived', excludeId })
  if (tab === 'drivers')        return data.filter((u: any) => !u.drivers?.is_external)
  if (tab === 'vendor-drivers') return data.filter((u: any) =>  u.drivers?.is_external)
  return data
}

function matchesTabFilters(u: any, tab: Exclude<PeopleTab, 'all'>, f: FilterRule[]): boolean {
  if (!matchesFilter(f, 'status', u.status)) return false
  if (tab === 'clients') return matchesFilter(f, 'company', u.clients?.company_name)
  const d = u.drivers
  if (!matchesFilter(f, 'license', needsLicenseUpdate(d?.license_expiry) ? 'attention' : 'ok')) return false
  if (tab === 'drivers') return matchesFilter(f, 'driver_status', d?.status)
  return matchesFilter(f, 'vendor', d?.vendor_name) && matchesFilter(f, 'access', accessState(u.access))
}

/**
 * Every row of `tab` that passes the filters and search, in the list's own
 * order, plus how many drivers on the tab (before filtering) need a license
 * update — the notice above the table counts the whole roster, not the page.
 */
export async function listDirectory(params: {
  tab:        DirectoryTab
  filters:    FilterRule[]
  search:     string
  excludeId?: string
}): Promise<{ rows: any[]; licenseFlagCount: number }> {
  const { tab, filters, search, excludeId } = params

  if (tab === 'all-admins' || tab in STAFF_ROLE) {
    return { rows: await listStaff(tab as StaffTab | 'all-admins', filters, search, excludeId), licenseFlagCount: 0 }
  }

  if (tab === 'all') {
    const role   = allowedValues(filters, 'role', ['client', 'driver'])
    const status = allowedValues(filters, 'status', CURRENT_STATUSES) ?? [...CURRENT_STATUSES, 'archived']
    const { data } = await FetchUsersService.getUsers({
      role:    role?.length ? role.join(',') : 'client,driver',
      status:  status.length ? status.join(',') : undefined,
      excludeId,
    })
    return { rows: data.filter((u: any) => matchesWords(search, peopleSearchFields(u))), licenseFlagCount: 0 }
  }

  const peopleTab = tab as Exclude<PeopleTab, 'all'>
  const status   = allowedValues(filters, 'status', CURRENT_STATUSES)
  const archived = !status?.includes('archived') ? 'none' : status.length === 1 ? 'only' : 'both'
  const all =
    archived === 'only' ? await archivedRows(peopleTab, excludeId)
    : archived === 'both' ? (await Promise.all([currentRows(peopleTab), archivedRows(peopleTab, excludeId)])).flat()
    : await currentRows(peopleTab)

  const licenseFlagCount = tab === 'clients'
    ? 0
    : all.filter((u) => needsLicenseUpdate(u.drivers?.license_expiry)).length

  const rows = all.filter((u) =>
    matchesTabFilters(u, peopleTab, filters) && matchesWords(search, peopleSearchFields(u)))

  return { rows, licenseFlagCount }
}
