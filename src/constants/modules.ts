// Module-level RBAC registry — single source of truth on the backend.
// Mirrors logistics-frontend/src/constants/modules.ts (keep labels/keys in sync).

export interface ModulePermissionFlags {
  can_view:   boolean
  can_create: boolean
  can_edit:   boolean
  can_delete: boolean
  can_export: boolean
}

export const PERMISSION_FLAGS = [
  'can_view', 'can_create', 'can_edit', 'can_delete', 'can_export',
] as const

export const EMPTY_FLAGS: ModulePermissionFlags = {
  can_view: false, can_create: false, can_edit: false, can_delete: false, can_export: false,
}

// Roles whose access an IT Admin may tailor per module — every account type
// that appears in the Administrator Management panel.
export const MANAGED_ROLES = [
  'admin',
  'accountant',
  'general_manager',
  'fleet_admin',
  'operations_admin',
] as const
export type ManagedRole = (typeof MANAGED_ROLES)[number]

// Roles that are never restricted by module permissions. it_admin runs the
// permission panel itself, so it must never be lockable.
export const BYPASS_ROLES = ['it_admin'] as const

export function isManagedRole(role: string): role is ManagedRole {
  return (MANAGED_ROLES as readonly string[]).includes(role)
}
export function isBypassRole(role: string): boolean {
  return (BYPASS_ROLES as readonly string[]).includes(role)
}

// Gateable modules (the dashboard pages an IT Admin can grant).
export const MODULE_KEYS = [
  'user-management',
  'booking-management',
  'vehicle-management',
  'billing-management',
  'document-management',
  'transit-tracking',
  'transaction-history',
  'system-maintenance',
  'audit-logs',
] as const
export type ModuleKey = (typeof MODULE_KEYS)[number]

// Tiered access model mirrored from the frontend. The 5 granular flags remain the
// source of truth; these three levels are how an IT Admin assigns them:
//   read   -> view only
//   manage -> view + create + edit + export (day-to-day operations)
//   all    -> manage + delete (the destructive, top-tier privilege)
export type AccessLevel = 'none' | 'read' | 'manage' | 'all'

export function levelToFlags(level: AccessLevel): ModulePermissionFlags {
  switch (level) {
    case 'read':   return { can_view: true, can_create: false, can_edit: false, can_delete: false, can_export: false }
    case 'manage': return { can_view: true, can_create: true,  can_edit: true,  can_delete: false, can_export: true  }
    case 'all':    return { can_view: true, can_create: true,  can_edit: true,  can_delete: true,  can_export: true  }
    default:       return { ...EMPTY_FLAGS }
  }
}

// Which modules are assignable per managed role (matches the role's dashboard nav).
export const MODULES_BY_ROLE: Record<ManagedRole, ModuleKey[]> = {
  admin: [
    'user-management',
    'booking-management',
    'transit-tracking',
    'vehicle-management',
    'billing-management',
    'transaction-history',
    'document-management',
    'system-maintenance',
    'audit-logs',
  ],
  accountant: [
    'transaction-history',
    'document-management',
    'booking-management',
    'billing-management',
  ],
  general_manager: [
    'vehicle-management',
    'booking-management',
    'billing-management',
    'document-management',
  ],
  fleet_admin: ['vehicle-management', 'transit-tracking'],
  operations_admin: ['booking-management', 'document-management', 'transit-tracking'],
}

// Default access tier per role per module. Seeded into module_permissions when a
// managed-role user is created, so staff start least-privilege instead of with
// full access. IT Admin can still override per user. Modules omitted for a role
// (or set to a lower tier) follow MODULES_BY_ROLE — anything not listed here is
// treated as no access once a user has any rows. Inherently historical modules
// (audit-logs, transaction-history) default to read-only everywhere.
type DefaultTier = Exclude<AccessLevel, 'none'>
export const ROLE_MODULE_DEFAULTS: Record<ManagedRole, Partial<Record<ModuleKey, DefaultTier>>> = {
  admin: {
    'user-management':     'all',
    'booking-management':  'all',
    'vehicle-management':  'all',
    'billing-management':  'all',
    'document-management': 'all',
    'system-maintenance':  'all',
    'transit-tracking':    'manage',
    'transaction-history': 'read',
    'audit-logs':          'read',
  },
  accountant: {
    'billing-management':  'all',
    'document-management': 'manage',
    'booking-management':  'read',
    'transaction-history': 'read',
  },
  general_manager: {
    'booking-management':  'manage',
    'billing-management':  'manage',
    'vehicle-management':  'read',
    'document-management': 'read',
  },
  fleet_admin: {
    'vehicle-management': 'all',
    'transit-tracking':   'manage',
  },
  operations_admin: {
    'booking-management':  'all',
    'document-management': 'manage',
    'transit-tracking':    'manage',
  },
}

// Expand a role's default tiers into the permission rows persisted on creation.
// Return shape matches ModulePermissionInput (defined in permissions.types) but is
// spelled inline to avoid a circular import back into this module.
export function defaultPermissionsForRole(
  role: string,
): (ModulePermissionFlags & { module_name: ModuleKey })[] {
  if (!isManagedRole(role)) return []
  const defaults = ROLE_MODULE_DEFAULTS[role]
  return (Object.entries(defaults) as [ModuleKey, DefaultTier][]).map(
    ([module_name, tier]) => ({ module_name, ...levelToFlags(tier) }),
  )
}

// Ordered prefix → module map for the /api/admin router.
// Only routes that actually exist under /api/admin are listed; anything not
// matched here falls through to the existing role-based authorize() gate.
const MODULE_ROUTE_MAP: { prefix: string; module: ModuleKey }[] = [
  { prefix: '/truck-models',      module: 'vehicle-management' },
  { prefix: '/trucks',            module: 'vehicle-management' },
  { prefix: '/drivers',           module: 'vehicle-management' },
  { prefix: '/vendors',           module: 'vehicle-management' },
  { prefix: '/assignments',       module: 'booking-management' },
  // Cargo catalog + landline prefixes are managed on the admin-only System
  // Maintenance page, so their CRUD is governed by the system-maintenance tier
  // (which only the admin role holds). Clients still bypass (non-managed), so the
  // booking form's catalog dropdowns keep reading these.
  { prefix: '/handling-codes',    module: 'system-maintenance' },
  { prefix: '/commodities',       module: 'system-maintenance' },
  { prefix: '/products',          module: 'system-maintenance' },
  { prefix: '/landline-prefixes', module: 'system-maintenance' },
  // Admin-only staff/user CRUD -> user-management module.
  { prefix: '/admins',            module: 'user-management' },
  { prefix: '/accountants',       module: 'user-management' },
  { prefix: '/general-managers',  module: 'user-management' },
  { prefix: '/fleet-admins',      module: 'user-management' },
  { prefix: '/operations-admins', module: 'user-management' },
  { prefix: '/it-admins',         module: 'user-management' },
  { prefix: '/users',             module: 'user-management' },
  { prefix: '/audit-logs',        module: 'audit-logs' },
]

// Resolve the module a request path belongs to. Tolerates both the mounted
// (relative, e.g. "/trucks") and absolute ("/api/admin/trucks") forms.
export function moduleForPath(path: string): ModuleKey | null {
  const p = path.replace(/^\/api\/admin/, '')
  for (const { prefix, module } of MODULE_ROUTE_MAP) {
    if (p === prefix || p.startsWith(prefix + '/')) return module
  }
  return null
}

// HTTP method → the permission flag it requires.
export function requiredFlagForMethod(
  method: string,
): keyof ModulePermissionFlags | null {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return 'can_view'
    case 'POST':
      return 'can_create'
    case 'PUT':
    case 'PATCH':
      return 'can_edit'
    case 'DELETE':
      return 'can_delete'
    default:
      return null
  }
}

// Normalize an arbitrary object into a clean flag set (coerces to booleans,
// drops anything unexpected).
export function pickFlags(src: Partial<ModulePermissionFlags>): ModulePermissionFlags {
  return {
    can_view:   !!src.can_view,
    can_create: !!src.can_create,
    can_edit:   !!src.can_edit,
    can_delete: !!src.can_delete,
    can_export: !!src.can_export,
  }
}
