-- Outside-vendor drivers get a real, minimal account so the mobile app can show
-- them their run sheet.
--
-- They stay role='driver' rather than getting a role of their own. Driver access
-- is already scoped at the data layer -- attachDriverScope resolves the caller's
-- own driver_id, and isDriverAssignedToBooking gates every write -- so a new role
-- string would buy no security while forcing edits to every exhaustive
-- Record<UserRole, ...> map, the users_role_check constraint and this RPC.
--
-- What does need a discriminator is the ADMIN side, which reads users.role
-- directly. Without is_external, every subcontractor ever provisioned would show
-- up in Driver Management and, worse, could tick the availability calendar and
-- become selectable as company crew.
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS is_external boolean NOT NULL DEFAULT false;

-- Partial: external drivers are the rare case, and every query that cares is
-- either "exclude them" (company pools) or "only them" (the external roster).
CREATE INDEX IF NOT EXISTS drivers_is_external_idx
  ON public.drivers (is_external) WHERE is_external = true;

-- license_expiry is NOT NULL because a company driver's licence is vetted at
-- hiring. A vendor driver is typed in at assignment time from whatever the
-- dispatcher was told, and an expiry date is not among the fields ops captures.
-- Rather than invent a placeholder date that would later read as fact, allow
-- NULL and keep the original invariant exactly where it already held.
ALTER TABLE public.drivers
  ALTER COLUMN license_expiry DROP NOT NULL;

ALTER TABLE public.drivers
  DROP CONSTRAINT IF EXISTS drivers_license_expiry_required_for_internal;

ALTER TABLE public.drivers
  ADD CONSTRAINT drivers_license_expiry_required_for_internal
  CHECK (is_external OR license_expiry IS NOT NULL);

-- The vendor snapshot on the delivery stays the record of who actually drove.
-- These two columns say which account was provisioned off the back of it, so an
-- admin can revoke or re-invite from the booking, and so re-assigning the same
-- subcontractor to a second booking finds the existing account instead of
-- minting a duplicate.
ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS vendor_driver_email   text,
  ADD COLUMN IF NOT EXISTS vendor_driver_user_id uuid
    REFERENCES public.users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deliveries_vendor_driver_user_idx
  ON public.deliveries (vendor_driver_user_id)
  WHERE vendor_driver_user_id IS NOT NULL;
