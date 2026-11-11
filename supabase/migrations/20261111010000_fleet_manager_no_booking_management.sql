-- The Fleet Manager has no Booking Management (user 2026-11-11).
--
-- The page /fleet_admin/booking-management was removed and 'booking-management'
-- left the Fleet Manager's module list and role defaults (constants/modules.ts,
-- both repos). Existing Fleet Manager accounts still held a booking-management
-- row, which no screen shows any more but which still let them read the
-- /admin/assignments GET routes (trips, pauses, timeline, replacements, driving
-- shifts) through the API, since moduleGuard maps /assignments to this module.
--
-- A managed user with any saved rows resolves a module without a row to no
-- access, so deleting the row is enough. Every Fleet Manager account, whatever
-- its status, so a restored account doesn't bring it back. Rows only: no schema
-- change, no foreign keys touched.

delete from public.module_permissions mp
using public.users u
where mp.user_id = u.user_id
  and u.role = 'fleet_manager'
  and mp.module_name = 'booking-management';
