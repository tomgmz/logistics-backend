-- Archiving an account was logged as '<role>_deleted' ("Client <id> deleted"),
-- though nothing is deleted: the account is archived and its sign-in banned.
-- The code now logs '<role>_archived'; this relabels the rows already written so
-- the Audit Logs read the same way. Only the seven account-archive actions are
-- touched: the catalog items, landline prefixes, vehicle types, booking stops,
-- cargo lines, unsubmitted bookings and stored files really are deleted.

update public.audit_logs
   set action      = regexp_replace(action, '_deleted$', '_archived'),
       description = regexp_replace(description, ' deleted$', ' archived')
 where action in (
   'admin_deleted', 'client_deleted', 'driver_deleted', 'fleet_admin_deleted',
   'general_manager_deleted', 'it_admin_deleted', 'operations_admin_deleted'
 );
