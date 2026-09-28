-- Reports module (driver incidents) for the Company Administrator, the
-- Operations Manager and the Fleet Manager.
--
-- A managed user who has ANY module_permissions rows is denied every module
-- without one (moduleGuard + the dashboard shell both read it that way). So
-- adding the 'reports' key to ROLE_MODULE_DEFAULTS only reaches users created
-- from now on; everyone already provisioned needs the row written here, or the
-- new page opens on "Access restricted".
--
-- Tiers mirror ROLE_MODULE_DEFAULTS:
--   admin              -> All    (every flag)
--   operations_manager -> Manage (view + create + edit + export, no delete)
--   fleet_manager      -> Manage — but only over vehicle-related reports
--                         (breakdowns, accidents); the scoping is done by role
--                         in the report service, not by these flags.
--
-- Users with NO rows are left alone on purpose: they run on role defaults, and
-- writing a single row would switch them into matrix mode and lock them out of
-- everything else. Existing 'reports' rows (an IT Admin's choice) are kept.

-- The module-key whitelist. (The billing migration's note that module_name had
-- no CHECK was wrong — it does.) Rebuilt from MODULE_KEYS in
-- src/constants/modules.ts; 'billing-management' is dropped with it, since
-- those rows were already deleted when billing was removed.
-- The billing removal migration meant to delete these, but 5 rows were still
-- on production on 2026-09-28 and would fail the new CHECK. Billing is gone on
-- both sides, so nothing reads them.
delete from public.module_permissions where module_name = 'billing-management';

alter table public.module_permissions drop constraint if exists module_permissions_module_name_check;
alter table public.module_permissions add constraint module_permissions_module_name_check
  check (module_name in (
    'user-management',
    'booking-management',
    'vehicle-management',
    'document-management',
    'transit-tracking',
    'transaction-history',
    'system-maintenance',
    'audit-logs',
    'reports'
  ));

insert into public.module_permissions
  (user_id, module_name, can_view, can_create, can_edit, can_delete, can_export)
select
  u.user_id,
  'reports',
  true,
  true,
  true,
  u.role = 'admin',
  true
from public.users u
where u.role in ('admin', 'operations_manager', 'fleet_manager')
  and u.status <> 'archived'
  and exists (
    select 1 from public.module_permissions mp where mp.user_id = u.user_id
  )
on conflict (user_id, module_name) do nothing;
