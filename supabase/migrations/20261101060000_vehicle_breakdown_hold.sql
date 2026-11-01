-- A vehicle that breaks down on a delivery goes Under Maintenance by itself
-- (2026-11-01). Not a new status: every gate already keys off
-- under_maintenance (no assignment, hold survives the booking, booking flagged,
-- passing inspection to clear). These columns say WHY it is on hold, so
-- Vehicle Management can show "Under maintenance · broke down on BK-…".
--
-- No foreign keys on purpose: trucks is already linked to bookings and to
-- driver_reports through other tables/columns, and a second relationship makes
-- PostgREST refuse unnamed embeds (see 20261101030000 / 20261101050000).
ALTER TABLE public.trucks
  ADD COLUMN IF NOT EXISTS maintenance_reason     varchar(20)
    CHECK (maintenance_reason IS NULL OR maintenance_reason IN ('breakdown')),
  ADD COLUMN IF NOT EXISTS maintenance_since      timestamptz,
  ADD COLUMN IF NOT EXISTS maintenance_booking_id uuid,
  ADD COLUMN IF NOT EXISTS maintenance_report_id  uuid,
  ADD COLUMN IF NOT EXISTS maintenance_note       text;

-- The reason belongs to the hold: whatever takes the vehicle off Under
-- Maintenance (a passing inspection, the Fleet Manager's edit, any future
-- path) clears it too, so a stale "broke down" never outlives the hold.
CREATE OR REPLACE FUNCTION public.trucks_clear_maintenance_reason()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'under_maintenance' THEN
    NEW.maintenance_reason     := NULL;
    NEW.maintenance_since      := NULL;
    NEW.maintenance_booking_id := NULL;
    NEW.maintenance_report_id  := NULL;
    NEW.maintenance_note       := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trucks_clear_maintenance_reason ON public.trucks;
CREATE TRIGGER trg_trucks_clear_maintenance_reason
  BEFORE UPDATE OF status ON public.trucks
  FOR EACH ROW EXECUTE FUNCTION public.trucks_clear_maintenance_reason();
