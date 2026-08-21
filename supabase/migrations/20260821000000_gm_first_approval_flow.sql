-- Reshape the booking approval workflow around a GM-first chain:
--
--   client books -> GM approves/rejects (with remarks) -> operations assigns a
--   vehicle + driver -> driver is notified of the assignment and the fleet
--   manager is notified that one of their vehicles was taken.
--
-- Accounting no longer gates the flow. BLOWBAGETS moves off the booking and onto
-- the vehicle itself: the fleet manager inspects a truck, and only trucks whose
-- most recent inspection passed can be picked by operations.

-- 1. Driver availability -----------------------------------------------------
-- A newly created driver is NOT in the assignable pool: they opt in from the
-- mobile app once they are ready to take deliveries. 'unavailable' is the new
-- resting state; 'assigned' is set by the system while a delivery is in flight.
alter table public.drivers
  drop constraint if exists drivers_status_check;

alter table public.drivers
  add constraint drivers_status_check
  check (status in ('available', 'unavailable', 'assigned', 'on_leave', 'inactive'));

alter table public.drivers
  alter column status set default 'unavailable';

-- 2. Per-vehicle BLOWBAGETS inspections --------------------------------------
-- One row per inspection the fleet manager performs. History is kept; the LATEST
-- row per truck is what decides whether the truck is selectable. `passed` is
-- derived from the items at write time so queries never have to unpack the jsonb.
create table if not exists public.truck_inspections (
  inspection_id uuid primary key default gen_random_uuid(),
  truck_id      uuid not null references public.trucks(truck_id) on delete cascade,
  items         jsonb not null,
  passed        boolean not null,
  notes         text,
  inspected_by  uuid references public.users(user_id) on delete set null,
  inspected_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists truck_inspections_truck_latest_idx
  on public.truck_inspections (truck_id, inspected_at desc);

-- 3. GM approval proxy -------------------------------------------------------
-- The IT admin can appoint an accountant to stand in for the general manager on
-- booking approvals (GM on leave / busy). A proxy receives the same approval
-- notifications and may act on the GM review endpoint.
alter table public.users
  add column if not exists is_gm_proxy boolean not null default false;

-- 4. Fleet re-inspection reminders -------------------------------------------
-- The scheduler nudges the fleet manager to re-run BLOWBAGETS the day before the
-- booking and again on the day itself. These columns make each nudge idempotent
-- across restarts — a reminder is only sent when its column is still null.
alter table public.bookings
  add column if not exists fleet_recheck_day_before_at timestamptz,
  add column if not exists fleet_recheck_day_of_at     timestamptz;

-- 5. Booking sub-status shapes ----------------------------------------------
-- Operations may now send a booking back to the unassigned state (e.g. the
-- picked vehicle failed its re-inspection), so ops_status gains 'pending' back
-- as a reachable value from 'assigned' — the CHECK already allows both. The
-- fleet stage no longer gates dispatch; fleet_status is kept for historical rows
-- but is no longer written by the workflow.
