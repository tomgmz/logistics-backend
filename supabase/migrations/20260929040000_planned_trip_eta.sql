-- Planned arrival times, per trip and per stop.
--
-- The live ETA (driver_locations.eta_stops) only exists once a truck is moving.
-- This is the estimate BEFORE that: computed from Google's predicted traffic
-- for the planned departure, plus a fixed allowance for unloading at each stop
-- and reloading between runs (planned-eta.service.ts holds those numbers).
--
-- Chained run by run, the way the truck actually works: trip 2 cannot leave
-- until trip 1 has unloaded everywhere, driven back and reloaded. A trip that
-- has started is re-planned from its real loading time, so errors in earlier
-- runs stop compounding once the truck is on the road.
--
--   booking_trips.planned_departure_at   when the loaded truck leaves the origin
--   booking_trips.planned_arrival_at     arrival at the trip's LAST stop
--   booking_trips.planned_return_at      back at the origin, ready to reload
--   booking_trip_stops.planned_arrival_at
--
-- bookings.estimated_delivery becomes the last trip's planned_arrival_at, so
-- the screens that already read it keep working. It was a `date` — which cannot
-- hold an arrival time — and every row was NULL, so the type change loses
-- nothing.

begin;

alter table public.booking_trips
  add column if not exists planned_departure_at timestamptz,
  add column if not exists planned_arrival_at   timestamptz,
  add column if not exists planned_return_at    timestamptz;

alter table public.booking_trip_stops
  add column if not exists planned_arrival_at timestamptz;

alter table public.bookings
  alter column estimated_delivery type timestamptz
  using estimated_delivery::timestamptz;

commit;
