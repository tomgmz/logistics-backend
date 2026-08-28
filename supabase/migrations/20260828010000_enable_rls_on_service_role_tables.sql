-- Close the anon-key hole on the two tables added without RLS.
--
-- public.truck_inspections and public.driver_availability_days were each created
-- with a note that the backend uses the service-role key and so needs no RLS
-- policy. The policy part is right; leaving RLS switched OFF is not. RLS
-- disabled means PostgREST will serve those tables to anyone holding the
-- publishable anon key — which ships in the web and mobile clients — with full
-- read and write access. Every other public table already has it enabled.
--
-- Enabling RLS with NO policies is the correct end state here:
--
--   service_role  bypasses RLS entirely, so the Supabase client keeps working
--   the table owner  bypasses RLS too (no FORCE ROW LEVEL SECURITY), so the
--                    node-postgres pool keeps working
--   anon / authenticated  match no policy, so they get nothing
--
-- No application code path changes. If either table is ever read directly from
-- a client with the anon key, that read was already a security bug and will now
-- fail loudly instead of silently succeeding.

alter table public.truck_inspections          enable row level security;
alter table public.driver_availability_days   enable row level security;
