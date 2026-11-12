-- Stop times: "Loading finished" / "Unloading finished" is its own step
-- (user 2026-11-12). Each stop visit now runs, in navigation, with no step
-- skipped:
--
--   arrived (automatic, or "I've arrived" within 300 m)
--   → started  ("Start loading" / "Start unloading")
--   → finished ("Loading finished" / "Unloading finished")   ← new stored stage
--   → proof    (the proof photo: booking_trips.pickup_proof_at /
--               booking_trip_stops.delivered_at, unchanged)
--
-- Before this, "finished" was simply the proof time. Rows from older app
-- versions have no `finished` row; the web shows it as not recorded.
-- Additive only: no existing row changes.

ALTER TABLE public.stop_milestones DROP CONSTRAINT IF EXISTS stop_milestones_stage_check;
ALTER TABLE public.stop_milestones
  ADD CONSTRAINT stop_milestones_stage_check
  CHECK (stage IN ('arrived', 'started', 'finished', 'docked', 'departed'));
