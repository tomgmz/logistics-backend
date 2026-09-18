-- At most one ACTIVE IT Admin.
--
-- The system is meant to have exactly one IT Admin, but until now that was a
-- convention rather than a rule: createITAdmin did no count check and nothing in
-- the schema stopped a second one.
--
-- The rule matters more than an ordinary invariant because of what only the IT
-- Admin can do. Every STAFF password reset -- admin, general manager, accountant,
-- fleet manager, operations manager, and the IT Admin themselves -- routes to the
-- 'it_admin' queue, and assertOwnsRequest() refuses to let a Company Admin act on
-- those rows. Unlike the booking notifications, which always append 'admin' as a
-- fallback recipient, that queue has no fallback at all, and every recipient
-- lookup filters on status = 'active'. So with no ACTIVE IT Admin, staff reset
-- requests pile up as 'pending': invisible to everyone, and actionable by nobody.
--
-- Hence the predicate is scoped to 'active' rather than to "not archived". A
-- deactivated predecessor is a kept record, not a second office-holder, and
-- scoping it this way is what lets a handover deactivate the outgoing account and
-- install the incoming one inside a single transaction (see
-- 20260916020000_transition_it_admin.sql) -- with no instant in between at which
-- the queue is unstaffed.
--
-- Unique on `role` with a predicate that pins role to one value means at most one
-- row can satisfy it. Writing it this way rather than on a constant expression
-- keeps the index self-describing in \d output.

create unique index if not exists users_one_active_it_admin
  on public.users (role)
  where role = 'it_admin' and status = 'active';
