-- Stop times, simplified (2026-11-01).
--
-- The driver no longer taps "arrived at parking", "arrived at docking" and
-- "departed": too much to ask at every stop. What is kept per stop visit:
--
--   arrived  → started → [finished = proof]
--
-- `arrived` is recorded by the phone itself, when navigation detects the
-- arrival (or the driver opens the stop's proof popup, whichever comes first).
-- `started` is the one button left: "Start loading" / "Start unloading".
--
-- Existing "arrived at parking" rows ARE the arrival, so they become `arrived`.
-- `docked` and `departed` rows already recorded stay as history; nothing new
-- writes them and no screen shows them.

ALTER TABLE public.stop_milestones DROP CONSTRAINT IF EXISTS stop_milestones_stage_check;

UPDATE public.stop_milestones SET stage = 'arrived' WHERE stage = 'arrived_parking';

ALTER TABLE public.stop_milestones
  ADD CONSTRAINT stop_milestones_stage_check
  CHECK (stage IN ('arrived', 'started', 'docked', 'departed'));
