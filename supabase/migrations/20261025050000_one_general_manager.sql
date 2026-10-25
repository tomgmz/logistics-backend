-- Only one General Manager in the system (2026-10-25, the user's call).
--
-- "One" means one account that is not archived: active, deactivated, revoked or
-- locked all count, so replacing the General Manager means archiving the old
-- account first. Archived accounts are kept (archive, not delete) and can be
-- restored only while no other General Manager exists.
--
-- The service checks (create / restore) give the friendly message; this index is
-- the guarantee when two requests race. Before it was added, the second active
-- General Manager (Tristan Ho) was archived through the app's archive service,
-- keeping Victor Vargas.

create unique index if not exists users_one_general_manager
  on public.users (role)
  where role = 'general_manager' and status <> 'archived';
