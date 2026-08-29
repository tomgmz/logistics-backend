-- Where the truck is right now, so the client can watch it come.
--
-- Until this table the system stored a driver's position exactly twice per stop:
-- the one-shot geofence stamp taken when they confirmed pickup or a drop-off
-- (`pickup_proof_latitude` / `proof_latitude`). Everything in between was thrown
-- away, so the client's "Delivery Tracking" map had nothing real to draw and fell
-- back to pinning the truck icon on the next undelivered stop's address — a guess
-- shown as a fact.
--
-- Two tables, because the two questions have very different shapes:
--
--   driver_locations         "where is this driver now" — one row per driver,
--                            UPSERTed in place. Bounded at the size of the fleet
--                            forever, which is what the live map reads on every
--                            ping. Keyed on the driver rather than the booking so
--                            it stays one row per driver across trips, and so a
--                            fleet-wide view costs one unfiltered scan.
--
--   driver_location_history  "where was it at 14:20" — append-only breadcrumbs,
--                            pruned to 30 days. This is evidence: receiving-bay
--                            detention is billable and route disputes are argued
--                            after the fact, neither of which a single current
--                            position can answer. 30 days comfortably outlives the
--                            billing period the claim would be raised against.
--
-- Both carry `recorded_at` (when the device took the fix) separately from
-- `created_at` (when it reached us). They differ by seconds normally and by much
-- more over a bad connection, and only the device's clock can order the track.
--
-- Backend writes and reads with the service-role key, so RLS is enabled with no
-- policies at all — service_role bypasses it, the table owner bypasses it, and
-- anon/authenticated match nothing and get nothing. Same reasoning as
-- 20260828010000_enable_rls_on_service_role_tables.sql, and it matters more here:
-- a live vehicle position readable with the publishable anon key would be a
-- standing location leak, not just a data leak.

create table if not exists public.driver_locations (
  driver_id   uuid primary key references public.drivers(driver_id) on delete cascade,
  booking_id  uuid references public.bookings(booking_id) on delete set null,
  latitude    numeric not null,
  longitude   numeric not null,
  accuracy_m  numeric,
  speed_mps   numeric,
  heading_deg numeric,
  recorded_at timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- The client map asks "the position for this booking", never "for this driver",
-- so the booking has to be indexed even though it isn't the key.
create index if not exists driver_locations_booking_idx
  on public.driver_locations (booking_id);

create table if not exists public.driver_location_history (
  location_id uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references public.drivers(driver_id) on delete cascade,
  booking_id  uuid references public.bookings(booking_id) on delete set null,
  latitude    numeric not null,
  longitude   numeric not null,
  accuracy_m  numeric,
  speed_mps   numeric,
  heading_deg numeric,
  recorded_at timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Every read of this table is "the track for one booking, in order" — replaying a
-- trip or measuring time parked at a bay. Descending matches how it is read back.
create index if not exists driver_location_history_booking_time_idx
  on public.driver_location_history (booking_id, recorded_at desc);

-- The pruning job deletes by age across all bookings, which the composite index
-- above cannot serve.
create index if not exists driver_location_history_recorded_at_idx
  on public.driver_location_history (recorded_at);

-- Both writes for one ping, in one round trip.
--
-- This runs every few seconds per driver, so the two statements are worth
-- collapsing. More importantly the live row must only ever move *forward* in
-- device time: two pings can arrive out of order over a flaky link, and applying
-- the older one last would drag the truck backwards across the client's map. The
-- `where` on the conflict clause is the guard, and it cannot be expressed through
-- PostgREST's upsert — which has no where clause — so it lives here.
--
-- The history row is written either way. A fix that arrived late is still a true
-- record of where the truck was, and the breadcrumb trail is ordered by
-- recorded_at when it is read back.
create or replace function public.record_driver_position(
  p_driver_id   uuid,
  p_booking_id  uuid,
  p_latitude    numeric,
  p_longitude   numeric,
  p_accuracy_m  numeric,
  p_speed_mps   numeric,
  p_heading_deg numeric,
  p_recorded_at timestamptz
) returns void
language sql
as $$
  insert into public.driver_locations as dl (
    driver_id, booking_id, latitude, longitude,
    accuracy_m, speed_mps, heading_deg, recorded_at, updated_at
  )
  values (
    p_driver_id, p_booking_id, p_latitude, p_longitude,
    p_accuracy_m, p_speed_mps, p_heading_deg, p_recorded_at, now()
  )
  on conflict (driver_id) do update set
    booking_id  = excluded.booking_id,
    latitude    = excluded.latitude,
    longitude   = excluded.longitude,
    accuracy_m  = excluded.accuracy_m,
    speed_mps   = excluded.speed_mps,
    heading_deg = excluded.heading_deg,
    recorded_at = excluded.recorded_at,
    updated_at  = now()
  where excluded.recorded_at >= dl.recorded_at;

  insert into public.driver_location_history (
    driver_id, booking_id, latitude, longitude,
    accuracy_m, speed_mps, heading_deg, recorded_at
  )
  values (
    p_driver_id, p_booking_id, p_latitude, p_longitude,
    p_accuracy_m, p_speed_mps, p_heading_deg, p_recorded_at
  );
$$;

alter table public.driver_locations        enable row level security;
alter table public.driver_location_history enable row level security;

-- The function is called only by the backend's service-role client. Revoking the
-- client-facing roles keeps it off the publishable anon key's surface, which is
-- the same reasoning as the policy-less RLS above. service_role is then granted
-- back explicitly: revoking from PUBLIC removes the default EXECUTE that every
-- role inherits, service_role included, and without this the backend's own RPC
-- would fail with a permission error.
revoke all on function public.record_driver_position(
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, timestamptz
) from public, anon, authenticated;

grant execute on function public.record_driver_position(
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, timestamptz
) to service_role;

comment on table public.driver_locations is
  'Latest known position per driver, UPSERTed on every ping. Powers the live client map.';
comment on table public.driver_location_history is
  'Append-only position breadcrumbs, pruned to 30 days. Evidence for detention and route disputes.';
comment on column public.driver_locations.recorded_at is
  'When the device took the fix — not when it arrived. Only this can order the track.';
