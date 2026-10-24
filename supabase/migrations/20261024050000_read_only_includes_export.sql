-- Read Only now includes export: a user who can see a module can also export
-- it (Audit Logs, Transaction History, Document Management). Give every saved
-- Read Only row (view, no create/edit/delete) the export flag so the stored
-- rights match the tier. Manage All and no-access rows are untouched.

update module_permissions
set can_export = true
where can_view
  and not can_create
  and not can_edit
  and not can_delete
  and not can_export;
