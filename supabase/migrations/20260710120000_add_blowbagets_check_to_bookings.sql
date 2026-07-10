-- Fleet manager's BLOWBAGETS pre-dispatch vehicle inspection, recorded at the
-- moment of the fleet review. Stored as a JSON snapshot so the passing/failing
-- state of each item, who inspected, and when are all preserved:
--   {
--     "items": { "battery": true, "lights": true, ... "self": true },
--     "checked_by": "<user_id>",
--     "checked_at": "<iso8601>"
--   }
-- Backend writes/reads with the service-role key (same pattern as the rest of
-- the bookings workflow), so no RLS policy is added here.
alter table public.bookings
  add column if not exists blowbagets_check jsonb;
