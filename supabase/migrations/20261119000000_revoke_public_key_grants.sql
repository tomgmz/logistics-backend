-- Security review 2026-11-19 (F-01, defence in depth).
--
-- The web and driver app ship Supabase's public (anon) key for Realtime
-- broadcast only; every read goes through the backend with the service key.
-- Row-level security is on for every public table and no policy lets anon read
-- these, so this changes nothing anyone can see today. It removes the second way
-- in: a future table or policy mistake can no longer be read straight from the
-- browser with the key printed in the bundle.

-- Tables the anon role still held SELECT on (left over from early setup).
revoke select on table
  public.deliveries, public.notifications, public.gps_tracking, public.clients,
  public.audit_logs, public.drivers, public.driver_assignments, public.users,
  public.truck_assignments, public.maintenance_records, public.trucks,
  public.documents
from anon;

-- SECURITY DEFINER functions anyone could call through /rest/v1/rpc. The backend
-- calls these with the service key; the trigger function fires as a trigger,
-- which needs no EXECUTE grant.
revoke execute on function public.increment_otp_attempts(uuid) from public, anon, authenticated;
revoke execute on function public.purge_expired_auth_data()    from public, anon, authenticated;
revoke execute on function public.live_signal_trigger()        from public, anon, authenticated;
