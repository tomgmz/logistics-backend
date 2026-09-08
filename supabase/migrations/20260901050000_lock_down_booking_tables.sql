-- Close two doors that are currently unlocked but happen to be blocked by
-- furniture.
--
-- 1. `booking_destinations` carries four policies granted to the `public` role
--    with `USING (true)` / `WITH CHECK (true)` — read, insert, update and delete
--    for anyone the role hierarchy includes, which is `anon` and
--    `authenticated`. Today that is inert: neither role holds a table-level
--    GRANT on it, so a request with the publishable anon key is refused at the
--    privilege check before any policy is consulted. But the policies say the
--    table is open, and the only thing disagreeing is a GRANT nobody has run
--    yet. One "enable read access" toggle in the dashboard, or one routine
--    GRANT, and every customer's delivery addresses and coordinates become
--    world-readable with a key that ships in the browser bundle.
--
--    Replaced with the service-role-only policy `bookings` already uses. The API
--    reaches these tables with the service role, which is unaffected.
--
-- 2. `bookings` grants full DML to `anon`. RLS blocks it — an anon select
--    returns an empty set rather than an error — but the grant is not needed by
--    anything and should not be there.

DROP POLICY IF EXISTS booking_destinations_select_all ON public.booking_destinations;
DROP POLICY IF EXISTS booking_destinations_insert_all ON public.booking_destinations;
DROP POLICY IF EXISTS booking_destinations_update_all ON public.booking_destinations;
DROP POLICY IF EXISTS booking_destinations_delete_all ON public.booking_destinations;

DROP POLICY IF EXISTS booking_destinations_service_role ON public.booking_destinations;
CREATE POLICY booking_destinations_service_role
  ON public.booking_destinations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.bookings FROM anon;
