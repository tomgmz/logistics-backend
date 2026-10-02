-- Live tables, round two: every remaining staff table refreshes itself.
--
-- Same mechanism as 20260928050000_live_table_signals — an AFTER trigger sends
-- an id-only broadcast on a public topic and the screen re-reads from the API,
-- which applies every permission and scoping rule as usual. Nothing but
-- { table, id } ever goes out on these topics.
--
-- New topics:
--   live:users            User Management + Administrator Management (every
--                         tab, including vendor drivers' passkey/invite state)
--   live:password_resets  the Password Resets queue and its tab badge
--   live:audit_logs       Audit Logs (admin) + the IT Admin audit tab
--   live:system_logs      the IT Admin system tab
--   live:catalog          System Maintenance (handling codes, commodities,
--                         products, landline prefixes)
--
-- Transaction History and the client's Booking History ride the existing
-- live:bookings topic and need no trigger here.

-- Accounts. A role table row (clients, drivers) carries what the directory
-- shows beside the user row, so either one changing refreshes the list.
DROP TRIGGER IF EXISTS live_signal ON public.users;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('user_id', 'live:users');

DROP TRIGGER IF EXISTS live_signal ON public.clients;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('client_id', 'live:users');

DROP TRIGGER IF EXISTS live_signal ON public.drivers;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('driver_id', 'live:users');

-- Vendor drivers: enrolment invites and passkeys are their status column.
DROP TRIGGER IF EXISTS live_signal ON public.driver_enrollment_invites;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.driver_enrollment_invites
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('invite_id', 'live:users');

DROP TRIGGER IF EXISTS live_signal ON public.webauthn_credentials;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.webauthn_credentials
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('credential_pk', 'live:users');

DROP TRIGGER IF EXISTS live_signal ON public.password_reset_requests;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.password_reset_requests
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('request_id', 'live:password_resets');

-- Logs. Insert-only in practice, but a resolve/update should show too.
DROP TRIGGER IF EXISTS live_signal ON public.audit_logs;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('log_id', 'live:audit_logs');

DROP TRIGGER IF EXISTS live_signal ON public.system_logs;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.system_logs
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('log_id', 'live:system_logs');

-- Cargo catalog and landline prefixes (System Maintenance).
DROP TRIGGER IF EXISTS live_signal ON public.handling_codes;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.handling_codes
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('handling_code_id', 'live:catalog');

DROP TRIGGER IF EXISTS live_signal ON public.commodities;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.commodities
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('commodity_id', 'live:catalog');

DROP TRIGGER IF EXISTS live_signal ON public.products;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('product_id', 'live:catalog');

DROP TRIGGER IF EXISTS live_signal ON public.landline_prefixes;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.landline_prefixes
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('prefix_id', 'live:catalog');
