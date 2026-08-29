-- The BIR booklet's own details become editable data, not source code.
--
-- Every pre-printed pad carries an Authority to Print block in its footer: the
-- ATP number, the date it was granted, and the serial range it covers. That
-- block was hardcoded in src/lib/pdf/bir-document.ts, which meant buying a new
-- pad required a developer to edit a constant and redeploy the backend — for
-- what is really four fields of data entry.
--
-- These describe the physical paper in the drawer, exactly like next_number and
-- booklet_start already on this table, so they belong beside them.
--
-- They are stored as TEXT, deliberately, even the dates. The requirement is to
-- reproduce the pad's footer VERBATIM; parsing "08-06-2025" into a date and
-- formatting it again risks printing something subtly different from the paper,
-- and no arithmetic is ever done on these values.

alter table public.document_series
  -- e.g. 'OCN 057AU2025000012162'
  add column if not exists atp_number text,
  -- As printed, e.g. '08-06-2025'.
  add column if not exists atp_date text,
  -- e.g. '10 Bklts. (50x2) 001-500'
  add column if not exists booklet_label text,

  -- The printer's block. Rarely changes, but it is part of the same footer and
  -- a change of printer would otherwise send us back to editing code.
  add column if not exists printer_name text,
  add column if not exists printer_address text,
  add column if not exists printer_vat text,
  add column if not exists printer_accreditation text,
  add column if not exists printer_issued text,
  add column if not exists printer_expiry text,

  add column if not exists updated_by uuid references public.users(user_id) on delete set null;

comment on table public.document_series is
  'One row per BIR-registered booklet type. Holds the serial counter AND the Authority to Print footer printed on that pad, so a new booklet is configured by data entry rather than a code change.';

comment on column public.document_series.atp_number is
  'Authority to Print number from the pad footer, verbatim. Changes when a new ATP is granted — which is not necessarily every new pad.';

-- Seed from the two pads supplied as photographs. The SI and AR were authorised
-- separately and do NOT share an ATP, which is why this is per-row: printing one
-- pad''s ATP on the other''s document would point an examiner at the wrong
-- registered booklet.
update public.document_series set
  atp_number            = 'OCN 057AU2025000012162',
  atp_date              = '08-06-2025',
  booklet_label         = '10 Bklts. (50x2) 001-500',
  printer_name          = 'DACUYA''S PRINTING SERVICES',
  printer_address       = '158 Garcia St., San Vicente, San Pedro, Laguna',
  printer_vat           = 'VAT Reg. TIN: 252-456-817-00000   Tel. No.: 847-0090',
  printer_accreditation = 'Printer''s Accreditation No. 057MP2023000000005',
  printer_issued        = 'Date Issued: 10/11/2023',
  printer_expiry        = 'Expiry Date: 10/10/2028'
where series_key = 'service_invoice';

update public.document_series set
  atp_number            = 'OCN 057AU20280000014632',
  atp_date              = '06-03-2026',
  booklet_label         = '10 Bklts. (50x2) 0001-0500',
  printer_name          = 'DACUYA''S PRINTING SERVICES',
  printer_address       = '158 Garcia St., San Vicente, San Pedro, Laguna',
  printer_vat           = 'VAT Reg. TIN: 252-456-817-00000   Tel. No.: 847-0090',
  printer_accreditation = 'Printer''s Accreditation No. 057MP2023000000005',
  printer_issued        = 'Date Issued: 10/11/2023',
  printer_expiry        = 'Expiry Date: 10/10/2028'
where series_key = 'acknowledgement_receipt';
