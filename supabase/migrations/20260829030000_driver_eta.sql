-- Server-computed ETA, hung off the live position it is derived from.
--
-- Until now `estimated_arrival` and `total_duration` were declared in the API
-- types and never populated by anything, so the client's details panel rendered
-- an em dash where the answer to their actual question belongs: will this truck
-- make my receiving window. The Google Navigation SDK does compute a live ETA,
-- but only on the driver's handset, where nobody else can see it.
--
-- Stored on driver_locations rather than in its own table because an ETA is a
-- property of the current position — it is computed from it, invalidated by it
-- moving, and read at exactly the same moment. A separate table would be a join
-- for no gain and a second row to keep in step.
--
-- `eta_stops` holds the whole remaining route, not just the next stop:
--   [{ "destination_id": uuid, "eta_seconds": int, "eta_at": iso8601 }, ...]
-- One Routes API call returns a duration per leg, so per-stop ETAs are free once
-- the call is made, and a booking with three drop-offs wants all three.
--
-- `eta_origin_lat/lng` is where the driver was when this was computed. It is the
-- throttle: recomputing on every ping would mean a paid API call every few
-- seconds per driver, so a new ETA is only bought once the truck has actually
-- moved far enough for the old one to be wrong.

alter table public.driver_locations
  add column if not exists eta_stops       jsonb,
  add column if not exists eta_computed_at timestamptz,
  add column if not exists eta_origin_lat  numeric,
  add column if not exists eta_origin_lng  numeric;

comment on column public.driver_locations.eta_stops is
  'Remaining stops with their predicted arrival: [{destination_id, eta_seconds, eta_at}].';
comment on column public.driver_locations.eta_origin_lat is
  'Where the driver was when the ETA was computed — the distance half of the recompute throttle.';

-- Writes the ETA without touching the position, so a slow Routes call can never
-- hold up or overwrite the ping that triggered it. The guard makes it a no-op if
-- the driver has moved on to a different booking in the meantime.
create or replace function public.record_driver_eta(
  p_driver_id   uuid,
  p_booking_id  uuid,
  p_eta_stops   jsonb,
  p_origin_lat  numeric,
  p_origin_lng  numeric
) returns void
language sql
as $$
  update public.driver_locations
     set eta_stops       = p_eta_stops,
         eta_computed_at = now(),
         eta_origin_lat  = p_origin_lat,
         eta_origin_lng  = p_origin_lng
   where driver_id  = p_driver_id
     and booking_id = p_booking_id;
$$;

revoke all on function public.record_driver_eta(uuid, uuid, jsonb, numeric, numeric)
  from public, anon, authenticated;

grant execute on function public.record_driver_eta(uuid, uuid, jsonb, numeric, numeric)
  to service_role;
