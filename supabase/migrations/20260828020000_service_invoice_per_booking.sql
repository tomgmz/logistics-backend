-- One Service Invoice per booking, not per billing period.
--
-- A cut-off still consolidates and is cross-checked as a whole — the client
-- submits one billing summary for the period, and 8338 sends one weekly summary
-- — but once both sides agree, the period fans out into one Service Invoice per
-- booking rather than a single invoice for everything.
--
-- This also removes an ambiguity the contract never resolved. The 30/45/60 term
-- is chosen per booking, so a period holding a 30-day and a 60-day booking had
-- no defensible single due date. With one invoice per booking each invoice
-- simply carries its own booking's term, and the question disappears.

-- 1. Several charge lines may now belong to one booking -----------------------
-- The printed Service Invoice has a per-item breakdown, and with the invoice
-- scoped to a single booking that breakdown is where a booking's individual
-- charges belong (freight, surcharge, waiting time). The old one-line-per-
-- booking rule cannot express that.
alter table public.billing_period_items
  drop constraint if exists billing_period_items_booking_id_key;

-- 2. ...but a booking still belongs to exactly one period ---------------------
-- Dropping the unique above would otherwise let the same booking be
-- consolidated onto two different periods and billed twice. The invariant moves
-- to its own table, where a primary key states it directly: a booking is
-- claimed by at most one period at a time. Releasing a period (cancel or
-- roll-over) deletes its claims and returns those bookings to the pool.
create table if not exists public.billing_booking_claims (
  booking_id uuid primary key references public.bookings(booking_id) on delete cascade,
  period_id  uuid not null references public.billing_periods(period_id) on delete cascade,
  claimed_at timestamptz not null default now()
);

create index if not exists billing_booking_claims_period_idx
  on public.billing_booking_claims (period_id);

alter table public.billing_booking_claims enable row level security;

-- 3. Invoices hang off a booking ----------------------------------------------
-- period_id stays, so a cut-off's invoices can still be listed together, but it
-- is no longer unique — a period now has as many invoices as it has bookings.
alter table public.service_invoices
  drop constraint if exists service_invoices_period_id_key;

create index if not exists service_invoices_period_idx
  on public.service_invoices (period_id);

-- The hard guarantee against double-billing: a booking can be invoiced once.
-- Left nullable so an invoice covering something other than a delivery stays
-- representable, but the workflow always sets it.
alter table public.service_invoices
  add column if not exists booking_id uuid references public.bookings(booking_id) on delete restrict;

create unique index if not exists service_invoices_booking_unique
  on public.service_invoices (booking_id)
  where booking_id is not null;

comment on column public.service_invoices.booking_id is
  'The single booking this Service Invoice covers. The invoice takes its payment term from this booking, which is why a period fans out into one invoice per booking.';

comment on column public.service_invoices.period_id is
  'The billing period this invoice was consolidated under. NOT unique — one period issues one invoice per booking.';
