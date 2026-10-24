-- Module access is now two levels, Read Only and Manage All; the middle
-- "Manage" tier (view + create + edit + export, no delete) is retired.
-- Rows saved under it already display as Manage All in Manage Access, so give
-- them the delete flag too and the stored rights match what the screen shows.
-- Read Only rows (view only) and no-access rows are left as they are.

update module_permissions
set can_view   = true,
    can_create = true,
    can_edit   = true,
    can_delete = true,
    can_export = true
where can_view
  and (can_create or can_edit or can_export)
  and not (can_create and can_edit and can_delete and can_export);
