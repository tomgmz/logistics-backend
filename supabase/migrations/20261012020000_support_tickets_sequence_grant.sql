-- The support_tickets migration was applied over a direct database connection,
-- so the ticket-number sequence did not get the grants Supabase gives objects
-- created from the dashboard. The API (service_role) could not draw a number,
-- and every new ticket failed with "permission denied for sequence".
-- Same grants as booking_ref_seq.
GRANT USAGE, SELECT ON SEQUENCE public.support_tickets_ticket_number_seq TO service_role, authenticated;
