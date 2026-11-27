-- Proof missing on a drop-off (2026-11-27).
--
-- When the office completes a drop-off for the driver ("Complete for the
-- driver": phone stolen, dead or lost) no photo is recorded, so the client has
-- no proof for it. The drop-off then counts as "Proof missing" until staff
-- upload a Proof of Delivery for it (the signed delivery receipt that came back
-- on paper); it counts at once, there is no review step. The office is
-- reminded each office morning until then (proof-missing.scheduler.ts).
--
-- 1. documents.destination_id: which drop-off a Proof of Delivery proves.
--    Checked pg_constraint 2026-11-27: no FK from documents to
--    booking_destinations before this one, so no PostgREST embed becomes
--    ambiguous. ON DELETE SET NULL: the file is evidence and stays.
-- 2. booking_destinations.proof_reminded_at: when the office was last reminded
--    about this drop-off's missing proof (one reminder per booking per morning).
-- 3. Existing Proof of Delivery files on a one-drop-off booking are linked to it.
-- 4. No review step and no Contract uploads (user 2026-11-27): contracts archived, nothing left pending.

-- 1 ----------------------------------------------------------------------------
alter table public.documents
  add column if not exists destination_id uuid
    references public.booking_destinations(destination_id) on delete set null;

create index if not exists idx_documents_destination_id
  on public.documents(destination_id) where destination_id is not null;

alter table public.documents drop constraint if exists chk_documents_destination;
alter table public.documents add constraint chk_documents_destination
  check (destination_id is null or (document_type = 'proof_of_delivery' and booking_id is not null));

comment on column public.documents.destination_id is
  'The drop-off a Proof of Delivery proves. Once uploaded (and not archived) it clears that drop-off''s "Proof missing" mark. Set automatically on a booking with one drop-off.';

-- 2 ----------------------------------------------------------------------------
alter table public.booking_destinations
  add column if not exists proof_reminded_at timestamptz;

comment on column public.booking_destinations.proof_reminded_at is
  'Last time the office was reminded that this drop-off has no proof (delivered without a photo and no approved Proof of Delivery). proof-missing.scheduler.ts.';

-- 3 ----------------------------------------------------------------------------
update public.documents d
   set destination_id = (select bd.destination_id from public.booking_destinations bd where bd.booking_id = d.booking_id)
 where d.document_type = 'proof_of_delivery'
   and d.booking_id is not null
   and d.destination_id is null
   and (select count(*) from public.booking_destinations bd where bd.booking_id = d.booking_id) = 1;

-- 4 ---------------------------------------------------------------------------
-- No review step and no Contract uploads (user 2026-11-27). Every staff upload
-- now counts at once (documents.service saves it 'approved').
--  * Contract files still on file are archived: they stay in the Archive
--    module, kept as evidence, but are no longer listed (4 live + 1 already
--    archived on production on 2026-11-27, all still waiting for review).
--  * Anything still waiting for review counts as approved, with no reviewer,
--    like an upload made today (on 2026-11-27 only those contracts were).
--    Files rejected under the old review stay rejected and hidden from clients.
update public.documents
   set archived_at = now()
 where document_type = 'contract'
   and archived_at is null;

update public.documents
   set status = 'approved', reviewed_at = coalesce(reviewed_at, now())
 where status = 'pending';
