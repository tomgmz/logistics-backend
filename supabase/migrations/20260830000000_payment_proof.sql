-- Proof of payment for money that moves outside the system.
--
-- Clients settle by bank transfer or check, so nothing in the app knows the
-- payment happened. Until now only an accountant could record one, from
-- information reaching them out-of-band: the client had no way to say "I paid"
-- and no visibility once they had.
--
-- This extends billing_payments rather than adding a parallel proofs table. A
-- payment is a payment; awaiting verification is a STATE it is in, not a
-- different kind of thing. Modelling it separately would mean two tables that
-- must agree on the same money, and a settlement query that has to remember to
-- consult both.

alter table public.billing_payments
  add column if not exists status text not null default 'confirmed'
    check (status in ('pending_verification', 'confirmed', 'rejected')),

  -- Cloudinary URLs for the deposit slip, transfer screenshot or check photo.
  add column if not exists proof_urls text[] not null default '{}',

  -- When the client says the money actually left their account. Kept apart from
  -- payment_date because 8338 only ACCEPTS payment on Fridays, while a transfer
  -- can land any day; collapsing the two would either break the Friday rule or
  -- force the client to enter a date that is not true.
  add column if not exists client_declared_date date,

  add column if not exists submitted_by uuid references public.users(user_id) on delete set null,
  add column if not exists submitted_at timestamptz,

  add column if not exists verified_by uuid references public.users(user_id) on delete set null,
  add column if not exists verified_at timestamptz,
  add column if not exists rejection_reason text;

-- Existing rows were all recorded directly by an accountant, which is exactly
-- what 'confirmed' means, so the default above needs no backfill.

-- A payment awaiting verification has no accepted date yet — that is the
-- accountant's to set, on the Friday 8338 took it. The service requires it at
-- confirmation, which is where the Friday rule already lives.
alter table public.billing_payments
  alter column payment_date drop not null;

comment on column public.billing_payments.status is
  'pending_verification until 8338 confirms the money arrived. ONLY confirmed payments count toward settling an invoice — a client uploading proof must never be able to mark their own invoice paid.';

comment on column public.billing_payments.payment_date is
  'The Friday 8338 accepted the payment. Null while pending; required on confirmation. See client_declared_date for when the client actually transferred.';

-- The accountant's queue: everything waiting on them, oldest first.
create index if not exists billing_payments_pending_idx
  on public.billing_payments (status, submitted_at)
  where status = 'pending_verification';
