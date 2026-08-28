-- Reverse billing: the two arrangements 8338 actually operates.
--
-- Both bill a PERIOD, never a single booking, and they run in opposite
-- directions:
--
--   weekly   8338 consolidates a Mon-Sat week, sends the summary, and the
--            client cross-checks it (3 working days to approve or reject).
--   monthly  8338 consolidates a half-month cut-off, then the CLIENT sends
--            their own billing summary and 8338 cross-checks it against the
--            consolidation. The client must not see 8338's figures first, or
--            the cross-check stops being a control.
--
-- Both converge once agreed: Service Invoice issued (which starts the client's
-- 30/45/60 day term) -> payment, accepted on Fridays only -> Acknowledgement
-- Receipt -> period closed.
--
-- Dates are computed in src/lib/billing-calendar.ts, not here. Period windows
-- are stored rather than derived on read so that a period keeps the schedule it
-- was actually issued under, even if the rules are later changed.

-- 0. Retire the abandoned first-pass billing schema ---------------------------
-- public.billing / reverse_billing / billing_disputes predate this work, hold
-- ZERO rows, and are referenced by no application code. They cannot carry the
-- real process: `billing.booking_id` ties a bill to one booking, and
-- `reverse_billing.client_summary` is a single text blob where line items,
-- revisions, VAT and the SI/AR split need to be. Dropping them keeps one
-- billing model in the database instead of two.
-- public.expenses is a different domain (fuel, tolls, driver cash-outs) and is
-- deliberately left alone.
drop table if exists public.billing_disputes cascade;
drop table if exists public.reverse_billing  cascade;
drop table if exists public.billing          cascade;

-- 1. Non-working holidays -----------------------------------------------------
-- 8338 is closed on Sundays and on declared non-working holidays. Holidays move
-- the day a weekly summary is SENT and the client's review days; they do not
-- reshape the billing week itself, so that both parties can still agree on what
-- a week covers by looking at a calendar.
create table if not exists public.ph_holidays (
  holiday_date date primary key,
  name         text not null,
  created_at   timestamptz not null default now()
);

-- 2. Billing periods — the spine ----------------------------------------------
-- One row per client per cycle. Everything else hangs off this.
create table if not exists public.billing_periods (
  period_id     uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(client_id) on delete cascade,

  -- Snapshot of the client's arrangement at generation time. A client who
  -- switches from weekly to monthly must not retroactively reshape closed
  -- periods, so this is copied, not read through to clients.billing_mode.
  mode          text not null check (mode in ('weekly', 'monthly')),
  period_start  date not null,
  period_end    date not null,
  -- 1 = the 1st-15th, 2 = the 16th to month end. Null for weekly.
  cutoff_no     smallint check (cutoff_no in (1, 2)),

  -- The schedule this period was issued under, from billing-calendar.ts.
  consolidation_start date,
  consolidation_end   date,
  submission_start    date,
  submission_end      date,
  validation_start    date,
  validation_end      date,

  status text not null default 'draft' check (status in (
    'draft',                    -- generated; the period has not closed yet
    'consolidating',            -- 8338 is finalising bookings and prices
    'awaiting_submission',      -- monthly: waiting on the client's summary
    'awaiting_client_approval', -- weekly: summary sent, 3-day clock running
    'under_review',             -- monthly: client submitted, accountant checking
    'rejected',                 -- mismatch; loops back for another round
    'approved',                 -- both sides agree on the figures
    'invoiced',                 -- Service Invoice issued, payment term running
    'paid',                     -- payment received and recorded
    'closed',                   -- Acknowledgement Receipt issued
    'cancelled',
    'rolled_over'               -- monthly: submission missed, superseded
  )),
  -- Which side rejected, so the UI can address the right party.
  rejected_by text check (rejected_by in ('client', 'company')),

  -- Idempotency stamps for the scheduler: each nudge fires only while its
  -- column is still null, which keeps restarts from re-sending.
  consolidation_opened_at   timestamptz,
  summary_sent_at           timestamptz,  -- weekly
  submission_window_notified_at timestamptz, -- monthly
  review_due_on             date,         -- weekly: last day of the 3-day window
  review_lapsed_notified_at timestamptz,  -- weekly: follow-up nudge sent
  submitted_at              timestamptz,
  validated_at              timestamptz,
  validated_by              uuid references public.users(user_id) on delete set null,

  -- Set on the period that was missed; points at the one that absorbed it.
  rolled_into_period_id uuid references public.billing_periods(period_id) on delete set null,

  -- Denormalised sum of billing_period_items.amount, maintained on write.
  total_amount numeric(14,2) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A client cannot have the same cycle twice.
  unique (client_id, mode, period_start, period_end),
  constraint billing_periods_range_valid check (period_end >= period_start),
  -- cutoff_no is required for monthly and meaningless for weekly.
  constraint billing_periods_cutoff_matches_mode check (
    (mode = 'monthly' and cutoff_no is not null) or
    (mode = 'weekly'  and cutoff_no is null)
  )
);

-- The scheduler sweeps by status and window date; the UI lists by client.
create index if not exists billing_periods_status_idx
  on public.billing_periods (status, period_end);
create index if not exists billing_periods_client_idx
  on public.billing_periods (client_id, period_start desc);

-- 3. Consolidated line items --------------------------------------------------
-- What the Service Invoice prints: "Item Description / Nature of Service",
-- Quantity, Unit Cost/Price, Amount. Amounts are entered by 8338 during
-- consolidation — there is no rate card, and the contract does not imply one.
create table if not exists public.billing_period_items (
  item_id     uuid primary key default gen_random_uuid(),
  period_id   uuid not null references public.billing_periods(period_id) on delete cascade,
  -- Null for an adjustment line (surcharge, discount) with no booking behind it.
  booking_id  uuid references public.bookings(booking_id) on delete restrict,

  description text not null,
  quantity    numeric(12,2) not null default 1 check (quantity > 0),
  unit_price  numeric(14,2) not null default 0 check (unit_price >= 0),
  amount      numeric(14,2) not null default 0,
  sort_order  int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A booking can be billed exactly once, ever. Postgres allows repeated NULLs,
  -- so adjustment lines are unaffected. Items are deleted when a period is
  -- cancelled or rolled over, which releases its bookings to the next cycle.
  unique (booking_id)
);

create index if not exists billing_period_items_period_idx
  on public.billing_period_items (period_id, sort_order);

-- 4. Submissions and reviews --------------------------------------------------
-- Direction-neutral, because the same rejection loop runs both ways:
--
--   monthly  the CLIENT submits (origin='client'); 8338 accepts or rejects.
--            On rejection the client submits revision 2, 3, ...
--   weekly   8338 sends the summary (origin='company'); the CLIENT accepts or
--            rejects. On rejection 8338 revises and resends as revision 2.
create table if not exists public.billing_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  period_id     uuid not null references public.billing_periods(period_id) on delete cascade,
  revision      int  not null default 1 check (revision >= 1),
  origin        text not null check (origin in ('client', 'company')),

  -- What the client claims they owe. Null on a company-origin (weekly) row,
  -- where the figures live in billing_period_items instead.
  submitted_amount     numeric(14,2),
  client_billing_number text,
  client_billing_date   date,
  remarks               text,
  -- Cloudinary URLs; the DB never stores the file itself.
  document_urls text[] not null default '{}',

  submitted_by uuid references public.users(user_id) on delete set null,
  submitted_at timestamptz not null default now(),

  review_status  text not null default 'pending'
                 check (review_status in ('pending', 'accepted', 'rejected')),
  review_remarks text,
  reviewed_by    uuid references public.users(user_id) on delete set null,
  reviewed_at    timestamptz,

  unique (period_id, revision)
);

create index if not exists billing_submissions_period_idx
  on public.billing_submissions (period_id, revision desc);

-- 5. Document serial numbers --------------------------------------------------
-- The Service Invoice and Acknowledgement Receipt are BIR-registered pre-printed
-- booklets with serials already on the paper. The system auto-increments to keep
-- typing down, but the accountant can override at issuance, because the physical
-- booklet — not this table — is the authority. booklet_start/end bound the pad
-- currently in use so the UI can warn when a serial falls outside it.
create table if not exists public.document_series (
  series_key    text primary key check (series_key in ('service_invoice', 'acknowledgement_receipt')),
  next_number   bigint not null,
  booklet_start bigint,
  booklet_end   bigint,
  -- Width for zero-padding on the rendered document: SI prints 151, AR 0015.
  pad_width     smallint not null default 1,
  updated_at    timestamptz not null default now()
);

-- Seeded from the booklets currently in use. Adjust to the real next unused
-- serial before the first issuance.
insert into public.document_series (series_key, next_number, booklet_start, booklet_end, pad_width)
values
  ('service_invoice',          151, 1, 500, 1),
  ('acknowledgement_receipt',   15, 1, 500, 4)
on conflict (series_key) do nothing;

-- 6. Service Invoices ---------------------------------------------------------
-- Mirrors the printed form field for field, including the VAT and withholding
-- blocks, so the generated PDF can be laid out straight from one row.
create table if not exists public.service_invoices (
  invoice_id uuid primary key default gen_random_uuid(),
  -- One invoice per period. Splitting a period across invoices is not a case the
  -- contract describes.
  period_id  uuid not null unique references public.billing_periods(period_id) on delete restrict,

  si_number    text not null unique,
  invoice_date date not null,
  sale_type    text not null default 'charge' check (sale_type in ('cash', 'charge')),

  -- SOLD TO, snapshotted at issuance: an issued invoice must not change when
  -- the client later edits their profile.
  sold_to_name    text not null,
  sold_to_tin     text,
  sold_to_address text,

  -- Left-hand totals block.
  vatable_sales     numeric(14,2) not null default 0,
  vat_amount        numeric(14,2) not null default 0,
  zero_rated_sales  numeric(14,2) not null default 0,
  vat_exempt_sales  numeric(14,2) not null default 0,
  -- Right-hand totals block.
  total_sales_vat_inclusive numeric(14,2) not null default 0,
  net_of_vat                numeric(14,2) not null default 0,
  discount_rate             numeric(5,2)  not null default 0,
  discount_amount           numeric(14,2) not null default 0,
  withholding_tax_rate      numeric(5,2)  not null default 0,
  withholding_tax_amount    numeric(14,2) not null default 0,
  total_amount_due          numeric(14,2) not null default 0,

  -- Issuance starts the clock. term_end_date is the raw expiry; due_date is that
  -- rounded forward to a Friday, since 8338 only accepts payment on Fridays.
  payment_terms_days smallint not null check (payment_terms_days in (30, 45, 60)),
  term_end_date      date not null,
  due_date           date not null,

  payment_status text not null default 'unpaid'
                 check (payment_status in ('unpaid', 'due', 'overdue', 'paid', 'cancelled')),
  -- Idempotency stamp for the scheduler's unpaid -> due -> overdue sweep.
  overdue_notified_at timestamptz,

  pdf_url   text,
  issued_by uuid references public.users(user_id) on delete set null,
  issued_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_invoices_due_idx
  on public.service_invoices (payment_status, due_date);

-- 7. Payments -----------------------------------------------------------------
-- payment_date is constrained to a Friday in the service layer rather than here:
-- a CHECK would also reject legitimate historical corrections, and the rule is
-- about when 8338 ACCEPTS payment, not about what is representable.
create table if not exists public.billing_payments (
  payment_id   uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.service_invoices(invoice_id) on delete restrict,
  amount_paid  numeric(14,2) not null check (amount_paid > 0),
  payment_date date not null,
  method       text not null check (method in ('cash', 'check')),
  reference_no text,
  notes        text,
  recorded_by  uuid references public.users(user_id) on delete set null,
  recorded_at  timestamptz not null default now()
);

create index if not exists billing_payments_invoice_idx
  on public.billing_payments (invoice_id, payment_date);

-- 8. Acknowledgement Receipts -------------------------------------------------
-- Issued after payment, as both a soft and a hard copy; closes the cycle.
create table if not exists public.acknowledgement_receipts (
  ar_id      uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.billing_payments(payment_id) on delete restrict,
  invoice_id uuid not null references public.service_invoices(invoice_id) on delete restrict,

  ar_number    text not null unique,
  receipt_date date not null,
  account_no   text,

  -- RECEIVED FROM block, snapshotted like the invoice's SOLD TO.
  received_from_name text not null,
  business_address   text,
  tin                text,

  payment_method text not null check (payment_method in ('cash', 'check')),
  payment_for    text,
  description    text,
  total_paid_amount numeric(14,2) not null,
  -- Spelled out on the printed form; generated at issuance.
  amount_in_words text,

  pdf_url   text,
  issued_by uuid references public.users(user_id) on delete set null,
  issued_at timestamptz not null default now(),

  created_at timestamptz not null default now()
);

-- 9. Client billing arrangement ----------------------------------------------
-- Which arrangement a client is on comes from their contract and is chosen by
-- the admin at account creation.
alter table public.clients
  add column if not exists billing_mode text check (billing_mode in ('weekly', 'monthly'));

-- The Service Invoice SOLD TO block needs a registered name and TIN, which the
-- clients table never carried. registered_name falls back to company_name when
-- the trading name and the BIR-registered name are the same.
alter table public.clients
  add column if not exists tin             text,
  add column if not exists registered_name text;

-- Existing clients predate the mode being captured; default them to monthly so
-- no row is left in an unbillable state, and let the admin correct them.
update public.clients set billing_mode = 'monthly' where billing_mode is null;

-- clients.payment_terms is superseded: the 30/45/60 term is chosen per booking,
-- and the arrangement (weekly vs monthly) now lives in billing_mode. The column
-- is left in place rather than dropped so existing rows keep their history.
comment on column public.clients.payment_terms is
  'DEPRECATED as of the reverse billing module. The payment term is taken from bookings.payment_terms at invoice issuance; the billing arrangement is clients.billing_mode.';

-- 10. Booking amount ----------------------------------------------------------
-- bookings.total_cost has existed unwritten since the base schema. It becomes a
-- denormalised mirror of the booking's consolidated line amount, which is what
-- the existing client-facing history screen already tries to display.
comment on column public.bookings.total_cost is
  'Mirror of billing_period_items.amount for this booking, written when its billing period is consolidated. billing_period_items is the source of truth.';

-- 11. Row Level Security ------------------------------------------------------
-- These tables hold financial records. RLS is enabled with NO policies: the
-- backend reaches Postgres as service_role (PostgREST) and as the owning role
-- (node-postgres), both of which bypass RLS, while the anon and authenticated
-- keys are left with no access at all. Without this, anyone holding the public
-- anon key could read every client's invoices.
alter table public.billing_periods           enable row level security;
alter table public.billing_period_items      enable row level security;
alter table public.billing_submissions       enable row level security;
alter table public.service_invoices          enable row level security;
alter table public.billing_payments          enable row level security;
alter table public.acknowledgement_receipts  enable row level security;
alter table public.document_series           enable row level security;
alter table public.ph_holidays               enable row level security;
