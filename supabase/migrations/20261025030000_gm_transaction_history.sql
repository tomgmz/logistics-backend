-- Transaction History for the General Manager (2026-10-25), at Read Only
-- (view + export), the same as every role that has it: there is nothing to
-- change in a history.
--
-- A managed user who has ANY module_permissions rows is denied every module
-- without one, so adding the module to ROLE_MODULE_DEFAULTS only reaches General
-- Managers created from now on. Everyone already provisioned gets the row here.
-- Users with NO rows run on role defaults and are left alone (one row would
-- switch them into matrix mode). An existing row (an IT Admin's choice) is kept.

insert into public.module_permissions
  (user_id, module_name, can_view, can_create, can_edit, can_delete, can_export)
select u.user_id, 'transaction-history', true, false, false, false, true
from public.users u
where u.role = 'general_manager'
  and u.status <> 'archived'
  and exists (
    select 1 from public.module_permissions mp where mp.user_id = u.user_id
  )
on conflict (user_id, module_name) do nothing;
