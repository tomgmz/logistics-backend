-- Document Management for the Fleet Manager (2026-11-08).
--
-- 1. Staff can file paperwork on a VEHICLE: documents.truck_id. Vehicle types
--    are Vehicle Registration and Insurance; Other (typed-in type) may go on a
--    vehicle too. A vehicle document never also names a booking or a client.
--    Only one FK from documents to trucks exists (checked pg_constraint
--    2026-11-08: none before), so no PostgREST embed becomes ambiguous.
-- 2. The Fleet Manager gets the document-management module (Manage All by
--    default). Fleet Managers who already have permission rows get the row
--    too; without one moduleGuard would refuse them.

-- 1 ----------------------------------------------------------------------------
alter table public.documents
  add column if not exists truck_id uuid references public.trucks(truck_id) on delete cascade;

create index if not exists idx_documents_truck_id on public.documents(truck_id) where truck_id is not null;

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check
  check (document_type in ('contract', 'proof_of_delivery', 'vehicle_registration', 'vehicle_insurance', 'other'));

alter table public.documents drop constraint if exists chk_documents_has_reference;
alter table public.documents add constraint chk_documents_has_reference
  check (booking_id is not null or delivery_id is not null or maintenance_id is not null
         or client_id is not null or truck_id is not null);

alter table public.documents drop constraint if exists chk_documents_vehicle;
alter table public.documents add constraint chk_documents_vehicle
  check (
    (document_type not in ('vehicle_registration', 'vehicle_insurance') or truck_id is not null)
    and (truck_id is null or (
      booking_id is null and client_id is null
      and document_type in ('vehicle_registration', 'vehicle_insurance', 'other')
    ))
  );

comment on column public.documents.truck_id is
  'A vehicle''s paperwork (Vehicle Registration, Insurance, Other), filed in the vehicle''s Fleet folder. Never set together with booking_id or client_id.';

-- 2 ----------------------------------------------------------------------------
insert into public.module_permissions
  (user_id, module_name, can_view, can_create, can_edit, can_delete, can_export)
select u.user_id, 'document-management', true, true, true, true, true
from public.users u
where u.role = 'fleet_manager'
  and u.status <> 'archived'
  and exists (select 1 from public.module_permissions mp where mp.user_id = u.user_id)
on conflict (user_id, module_name) do nothing;
