-- Live tables: staff screens refresh themselves when the rows behind them change.
--
-- Rows change from many paths — staff screens, the driver app (reports, fleet
-- return), the booking lifecycle (assignment puts a truck in_use, completion
-- releases it), schedulers. Emitting from each code path would miss some, so
-- the signal comes from the tables themselves.
--
-- Each trigger sends a Realtime broadcast on a public topic:
--     live:trucks  live:truck_models  live:driver_reports  live:bookings
-- The payload is ONLY { table, id }. Public topics can be joined with the anon
-- key, so nothing else is sent (same rule as record-locks: ids, never names or
-- data). Screens take the signal as "re-read from the API", which applies
-- every permission and scoping rule as usual.
--
-- A failed broadcast must never fail the write it describes, so the send is
-- wrapped and any error is swallowed.

CREATE OR REPLACE FUNCTION public.live_signal(p_topic text, p_table text, p_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, realtime
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('table', p_table, 'id', p_id),
    'changed',
    p_topic,
    false
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.live_signal(text, text, text) FROM PUBLIC, anon, authenticated;

-- One trigger function; the topics come in as trigger arguments and the id
-- column is read generically, so each table only declares what it feeds.
--   TG_ARGV[0] = id column, TG_ARGV[1..] = topics
CREATE OR REPLACE FUNCTION public.live_signal_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec   jsonb := to_jsonb(COALESCE(NEW, OLD));
  rowid text  := rec ->> TG_ARGV[0];
  i     int;
BEGIN
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    PERFORM public.live_signal(TG_ARGV[i], TG_TABLE_NAME, rowid);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Vehicles and everything that changes what a vehicle row shows (inspection
-- badge, odometer, service status, maintenance reasons).
DROP TRIGGER IF EXISTS live_signal ON public.trucks;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.trucks
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('truck_id', 'live:trucks');

DROP TRIGGER IF EXISTS live_signal ON public.truck_inspections;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.truck_inspections
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('truck_id', 'live:trucks');

DROP TRIGGER IF EXISTS live_signal ON public.truck_odometer_readings;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.truck_odometer_readings
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('truck_id', 'live:trucks');

DROP TRIGGER IF EXISTS live_signal ON public.truck_services;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.truck_services
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('truck_id', 'live:trucks');

DROP TRIGGER IF EXISTS live_signal ON public.truck_models;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.truck_models
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('model_id', 'live:truck_models');

-- Driver reports feed the Reports queue and the Maintenance tab.
DROP TRIGGER IF EXISTS live_signal ON public.driver_reports;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.driver_reports
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('report_id', 'live:driver_reports', 'live:trucks');

-- Bookings: the booking tables, and the vehicles list (a fleet return makes the
-- return odometer due). Deliveries carry the crew/vehicle assignment.
DROP TRIGGER IF EXISTS live_signal ON public.bookings;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings', 'live:trucks');

DROP TRIGGER IF EXISTS live_signal ON public.deliveries;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('booking_id', 'live:bookings');
