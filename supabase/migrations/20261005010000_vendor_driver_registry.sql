-- Vendor drivers are now registered up front in Driver Management, next to the
-- company (8338) drivers, instead of being typed into each booking's assignment.
--
-- They stay what they already were — role='driver' + drivers.is_external — so
-- the passkey sign-in, the exclusion from the company crew pool, and every
-- driver-scoped read keep working unchanged. What a registered vendor driver
-- needs on top is the vendor they come from, so Booking Management can copy it
-- onto the delivery snapshot instead of making the dispatcher type it again.
--
-- Nullable: company drivers have no vendor, and vendor drivers provisioned from
-- an assignment before this change were never asked for one.
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS vendor_name    text,
  ADD COLUMN IF NOT EXISTS vendor_contact text;
