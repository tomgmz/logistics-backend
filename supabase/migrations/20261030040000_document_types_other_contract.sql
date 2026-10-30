-- Staff document types, 2026-10-30.
--
-- The list is now Contract, Proof of Delivery and Other. Other carries a
-- short type the uploader typed in (other_label, up to 60 characters) and is
-- staff only. Contracts belong to a client, not a booking: client_id holds the
-- client and booking_id stays empty. Signed Delivery Receipt, Trip Ticket, DTR,
-- Purchase Order and Maintenance Record are retired (none was ever uploaded;
-- the table was empty when this ran).

alter table public.documents
  add column if not exists client_id   uuid references public.clients(client_id) on delete cascade,
  add column if not exists other_label varchar(60);

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check
  check (document_type in ('contract', 'proof_of_delivery', 'other'));

-- Every document belongs to something: a booking, a delivery, a maintenance
-- record, or (contracts) a client.
alter table public.documents drop constraint if exists chk_documents_has_reference;
alter table public.documents add constraint chk_documents_has_reference
  check (booking_id is not null or delivery_id is not null or maintenance_id is not null or client_id is not null);

-- Other always says what it is; nothing else carries a typed-in type.
alter table public.documents add constraint chk_documents_other_label
  check ((document_type = 'other') = (other_label is not null and btrim(other_label) <> ''));

-- A contract is a client's, never a booking's.
alter table public.documents add constraint chk_documents_contract_client
  check (document_type <> 'contract' or (client_id is not null and booking_id is null));

create index if not exists documents_client_id_idx on public.documents (client_id) where client_id is not null;
