-- Transit Tracking's booking list, live (2026-10-30).
--
-- The list re-reads on live:bookings. Bookings, deliveries, pauses, trip cargo
-- and stop milestones already signal it, but the rows behind each card's route
-- stepper and "2 of 3 drop-offs" did not: the trips (loaded, departed), the
-- trip stops (which drop-off is done) and the drop-offs themselves. A change
-- there only showed after something else on the booking moved, or a Refresh.
--
-- Same mechanism as 20260928050000_live_table_signals: an id-only broadcast,
-- the screen re-reads from the API. Separate trigger names, so the
-- live_signal_documents triggers on these tables are left alone.

DROP TRIGGER IF EXISTS live_signal_bookings ON public.booking_trips;
CREATE TRIGGER live_signal_bookings AFTER INSERT OR UPDATE OR DELETE ON public.booking_trips
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('trip_id', 'live:bookings');

DROP TRIGGER IF EXISTS live_signal_bookings ON public.booking_trip_stops;
CREATE TRIGGER live_signal_bookings AFTER INSERT OR UPDATE OR DELETE ON public.booking_trip_stops
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('trip_stop_id', 'live:bookings');

DROP TRIGGER IF EXISTS live_signal_bookings ON public.booking_destinations;
CREATE TRIGGER live_signal_bookings AFTER INSERT OR UPDATE OR DELETE ON public.booking_destinations
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('destination_id', 'live:bookings');
