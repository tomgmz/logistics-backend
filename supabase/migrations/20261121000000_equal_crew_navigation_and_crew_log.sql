-- Main and second driver are equal in the app; one phone navigates at a time;
-- every change of driver, second driver, helper or vehicle is recorded
-- (2026-11-21).
--
-- 1. booking_nav_claims: which crew member's phone is navigating the booking.
--    One open claim per booking (partial unique index). Another crew member
--    takes over from their own phone (the old phone may be dead); the old claim
--    is closed with end_reason 'taken_over' and the new one names who it was
--    taken from. That phone is also the truck's live position on the client's
--    map (tracking.service). Industry: Samsara / Motive / Garmin eLog team
--    driving keep one active device or driver at a time with an explicit switch.
--
-- 2. booking_crew_changes: one row per change of seat on a booking, written by
--    a trigger on deliveries so no write path can skip it. The API names who
--    did it and why with transaction-local settings (set_config(..., true),
--    safe on the transaction pooler):
--      app.actor_user_id, app.crew_change_source, app.crew_change_reason
--    A change made with none set (straight in the database) is still logged,
--    as source 'database'. Names and plates are snapshotted: a driver renamed
--    or archived later does not rewrite history.
--
-- No foreign keys to drivers / users from either table on the people columns
-- (except booking_nav_claims.driver_id): nothing embeds these tables, and the
-- history must outlive an archived driver.

CREATE TABLE IF NOT EXISTS public.booking_nav_claims (
  claim_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  driver_id       uuid NOT NULL REFERENCES public.drivers(driver_id) ON DELETE CASCADE,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  end_reason      text CHECK (end_reason IN ('released', 'taken_over', 'returned', 'removed')),
  -- drivers.driver_id whose phone was navigating when this one took over.
  took_over_from  uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_nav_claims_one_open
  ON public.booking_nav_claims (booking_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS booking_nav_claims_booking_idx
  ON public.booking_nav_claims (booking_id, claimed_at);
ALTER TABLE public.booking_nav_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_nav_claims FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.booking_crew_changes (
  change_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES public.bookings(booking_id) ON DELETE CASCADE,
  seat            text NOT NULL CHECK (seat IN ('driver', 'second_driver', 'helper', 'vehicle')),
  -- What identifies the seat's holder: a driver_id / truck_id, or for a vendor
  -- driver / vehicle / helper the typed name or plate.
  old_ref         text,
  new_ref         text,
  old_label       text,
  new_label       text,
  -- assigned | reassigned | replaced | swapped | database | backfill
  source          text NOT NULL,
  reason          text,
  changed_by      uuid,
  changed_by_role text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_crew_changes_booking_idx
  ON public.booking_crew_changes (booking_id, changed_at);
ALTER TABLE public.booking_crew_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_crew_changes FROM anon, authenticated;

-- A driver's name as shown on screen, or the vendor driver's typed name.
CREATE OR REPLACE FUNCTION public.crew_driver_label(p_driver_id uuid, p_fallback text)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT NULLIF(btrim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '')
       FROM drivers d JOIN users u ON u.user_id = d.user_id
      WHERE d.driver_id = p_driver_id),
    NULLIF(btrim(p_fallback), ''))
$$;

CREATE OR REPLACE FUNCTION public.crew_vehicle_label(p_truck_id uuid, p_fallback text)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT t.plate_number FROM trucks t WHERE t.truck_id = p_truck_id),
    NULLIF(btrim(p_fallback), ''))
$$;

CREATE OR REPLACE FUNCTION public.log_crew_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_by      uuid := NULLIF(current_setting('app.actor_user_id', true), '')::uuid;
  v_src     text := NULLIF(current_setting('app.crew_change_source', true), '');
  v_reason  text := NULLIF(current_setting('app.crew_change_reason', true), '');
  v_role    text;
  o_main text; n_main text; o_main_l text; n_main_l text;
  o_sec  text; n_sec  text; o_sec_l  text; n_sec_l  text;
  o_help text; n_help text;
  o_veh  text; n_veh  text; o_veh_l  text; n_veh_l  text;
  src    text;
BEGIN
  IF v_by IS NOT NULL THEN
    SELECT role INTO v_role FROM users WHERE user_id = v_by;
  END IF;

  n_main   := COALESCE(NEW.driver_id::text, NEW.vendor_driver_user_id::text, NULLIF(btrim(NEW.vendor_driver_name), ''));
  n_main_l := crew_driver_label(NEW.driver_id, NEW.vendor_driver_name);
  IF NEW.driver_id IS NULL AND NEW.vendor_driver_user_id IS NOT NULL THEN
    n_main_l := COALESCE(NULLIF(btrim(NEW.vendor_driver_name), ''),
      (SELECT NULLIF(btrim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') FROM users WHERE user_id = NEW.vendor_driver_user_id));
  END IF;
  n_sec    := NEW.second_driver_id::text;
  n_sec_l  := crew_driver_label(NEW.second_driver_id, NULL);
  n_help   := NULLIF(btrim(NEW.helper_name), '');
  n_veh    := COALESCE(NEW.truck_id::text, NULLIF(btrim(NEW.vendor_vehicle_plate), ''));
  n_veh_l  := crew_vehicle_label(NEW.truck_id, NEW.vendor_vehicle_plate);

  IF TG_OP = 'UPDATE' THEN
    o_main   := COALESCE(OLD.driver_id::text, OLD.vendor_driver_user_id::text, NULLIF(btrim(OLD.vendor_driver_name), ''));
    o_main_l := crew_driver_label(OLD.driver_id, OLD.vendor_driver_name);
    IF OLD.driver_id IS NULL AND OLD.vendor_driver_user_id IS NOT NULL THEN
      o_main_l := COALESCE(NULLIF(btrim(OLD.vendor_driver_name), ''),
        (SELECT NULLIF(btrim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') FROM users WHERE user_id = OLD.vendor_driver_user_id));
    END IF;
    o_sec    := OLD.second_driver_id::text;
    o_sec_l  := crew_driver_label(OLD.second_driver_id, NULL);
    o_help   := NULLIF(btrim(OLD.helper_name), '');
    o_veh    := COALESCE(OLD.truck_id::text, NULLIF(btrim(OLD.vendor_vehicle_plate), ''));
    o_veh_l  := crew_vehicle_label(OLD.truck_id, OLD.vendor_vehicle_plate);
  END IF;

  -- 'assignment' from the API: first fill of a seat = assigned, else re-assigned.
  -- Nothing set: an insert is the first assignment, an update came from outside the API.
  src := COALESCE(v_src, CASE WHEN TG_OP = 'INSERT' THEN 'assignment' ELSE 'database' END);

  IF o_main IS DISTINCT FROM n_main THEN
    INSERT INTO booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role)
    VALUES (NEW.booking_id, 'driver', o_main, n_main, o_main_l, n_main_l,
            CASE WHEN src = 'assignment' THEN CASE WHEN o_main IS NULL THEN 'assigned' ELSE 'reassigned' END ELSE src END,
            v_reason, v_by, v_role);
  END IF;
  IF o_sec IS DISTINCT FROM n_sec THEN
    INSERT INTO booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role)
    VALUES (NEW.booking_id, 'second_driver', o_sec, n_sec, o_sec_l, n_sec_l,
            CASE WHEN src = 'assignment' THEN CASE WHEN o_sec IS NULL THEN 'assigned' ELSE 'reassigned' END ELSE src END,
            v_reason, v_by, v_role);
  END IF;
  IF o_help IS DISTINCT FROM n_help THEN
    INSERT INTO booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role)
    VALUES (NEW.booking_id, 'helper', o_help, n_help, o_help, n_help,
            CASE WHEN src = 'assignment' THEN CASE WHEN o_help IS NULL THEN 'assigned' ELSE 'reassigned' END ELSE src END,
            v_reason, v_by, v_role);
  END IF;
  IF o_veh IS DISTINCT FROM n_veh THEN
    INSERT INTO booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role)
    VALUES (NEW.booking_id, 'vehicle', o_veh, n_veh, o_veh_l, n_veh_l,
            CASE WHEN src = 'assignment' THEN CASE WHEN o_veh IS NULL THEN 'assigned' ELSE 'reassigned' END ELSE src END,
            v_reason, v_by, v_role);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_crew_change() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crew_driver_label(uuid, text) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crew_vehicle_label(uuid, text) FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS log_crew_change ON public.deliveries;
CREATE TRIGGER log_crew_change
  AFTER INSERT OR UPDATE OF driver_id, second_driver_id, helper_name, truck_id,
                            vendor_driver_user_id, vendor_driver_name, vendor_vehicle_plate
  ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.log_crew_change();

-- Booking Management re-reads on live:bookings (same id-only signal as the rest).
DROP TRIGGER IF EXISTS live_signal_bookings ON public.booking_crew_changes;
CREATE TRIGGER live_signal_bookings AFTER INSERT ON public.booking_crew_changes
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings');
DROP TRIGGER IF EXISTS live_signal_bookings ON public.booking_nav_claims;
CREATE TRIGGER live_signal_bookings AFTER INSERT OR UPDATE ON public.booking_nav_claims
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings');

-- ── Backfill what was already on record ─────────────────────────────────────
-- Office swaps (main <-> second).
INSERT INTO public.booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role, changed_at)
SELECT s.booking_id, 'driver', s.old_lead_driver_id::text, s.new_lead_driver_id::text,
       public.crew_driver_label(s.old_lead_driver_id, NULL), public.crew_driver_label(s.new_lead_driver_id, NULL),
       'swapped', s.reason, s.swapped_by, (SELECT role FROM public.users WHERE user_id = s.swapped_by), s.swapped_at
  FROM public.booking_crew_swaps s;
INSERT INTO public.booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role, changed_at)
SELECT s.booking_id, 'second_driver', s.new_lead_driver_id::text, s.old_lead_driver_id::text,
       public.crew_driver_label(s.new_lead_driver_id, NULL), public.crew_driver_label(s.old_lead_driver_id, NULL),
       'swapped', s.reason, s.swapped_by, (SELECT role FROM public.users WHERE user_id = s.swapped_by), s.swapped_at
  FROM public.booking_crew_swaps s;

-- Replacements while paused.
INSERT INTO public.booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role, changed_at)
SELECT r.booking_id, 'driver', r.old_driver_id::text, r.new_driver_id::text,
       public.crew_driver_label(r.old_driver_id, NULL), public.crew_driver_label(r.new_driver_id, NULL),
       'replaced', r.reason_note, r.replaced_by, r.replaced_by_role, r.replaced_at
  FROM public.crew_replacements r
 WHERE r.new_driver_id IS NOT NULL AND r.new_driver_id IS DISTINCT FROM r.old_driver_id;
INSERT INTO public.booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role, changed_at)
SELECT r.booking_id, 'second_driver', r.old_second_driver_id::text, r.new_second_driver_id::text,
       public.crew_driver_label(r.old_second_driver_id, NULL), public.crew_driver_label(r.new_second_driver_id, NULL),
       'replaced', r.reason_note, r.replaced_by, r.replaced_by_role, r.replaced_at
  FROM public.crew_replacements r
 WHERE r.old_second_driver_id IS DISTINCT FROM r.new_second_driver_id;
INSERT INTO public.booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, reason, changed_by, changed_by_role, changed_at)
SELECT r.booking_id, 'vehicle', COALESCE(r.old_truck_id::text, r.old_vehicle_plate), COALESCE(r.new_truck_id::text, r.new_vehicle_plate),
       public.crew_vehicle_label(r.old_truck_id, r.old_vehicle_plate), public.crew_vehicle_label(r.new_truck_id, r.new_vehicle_plate),
       'replaced', r.reason_note, r.replaced_by, r.replaced_by_role, r.replaced_at
  FROM public.crew_replacements r
 WHERE COALESCE(r.new_truck_id::text, r.new_vehicle_plate) IS NOT NULL
   AND COALESCE(r.old_truck_id::text, r.old_vehicle_plate) IS DISTINCT FROM COALESCE(r.new_truck_id::text, r.new_vehicle_plate);

-- The assignment of bookings with no later change: the crew on record now is
-- the crew assigned (a re-assignment before the start was not kept before today).
INSERT INTO public.booking_crew_changes (booking_id, seat, old_ref, new_ref, old_label, new_label, source, changed_by, changed_by_role, changed_at)
SELECT d.booking_id, x.seat, NULL, x.ref, NULL, x.label, 'backfill', b.ops_assigned_by, b.ops_assigned_role,
       COALESCE(b.ops_assigned_at, d.created_at)
  FROM public.deliveries d
  JOIN public.bookings b ON b.booking_id = d.booking_id
  CROSS JOIN LATERAL (VALUES
    ('driver',        COALESCE(d.driver_id::text, d.vendor_driver_user_id::text, NULLIF(btrim(d.vendor_driver_name), '')),
                      public.crew_driver_label(d.driver_id, d.vendor_driver_name)),
    ('second_driver', d.second_driver_id::text, public.crew_driver_label(d.second_driver_id, NULL)),
    ('helper',        NULLIF(btrim(d.helper_name), ''), NULLIF(btrim(d.helper_name), '')),
    ('vehicle',       COALESCE(d.truck_id::text, NULLIF(btrim(d.vendor_vehicle_plate), '')),
                      public.crew_vehicle_label(d.truck_id, d.vendor_vehicle_plate))
  ) AS x(seat, ref, label)
 WHERE x.ref IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.booking_crew_changes c WHERE c.booking_id = d.booking_id);
