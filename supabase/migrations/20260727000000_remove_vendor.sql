-- Remove the Vendor user/entity. Vendor-supplied driver+vehicle are now captured
-- as an ad-hoc snapshot on the delivery (transit) record at assignment time.
-- Safe drops: no vendor users/vendors/vendor trucks/vendor drivers existed.

-- 1. Vendor snapshot columns on deliveries
ALTER TABLE deliveries
  ADD COLUMN is_vendor_supplied    boolean NOT NULL DEFAULT false,
  ADD COLUMN vendor_name           text,
  ADD COLUMN vendor_contact        text,
  ADD COLUMN vendor_driver_name    text,
  ADD COLUMN vendor_driver_license text,
  ADD COLUMN vendor_driver_phone   text,
  ADD COLUMN vendor_vehicle_plate  text,
  ADD COLUMN vendor_vehicle_type   text;

-- 2. drivers: drop vendor linkage
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_vendor_id_fkey;
ALTER TABLE drivers
  DROP COLUMN IF EXISTS is_vendor_driver,
  DROP COLUMN IF EXISTS vendor_id;

-- 3. trucks: company-only fleet
ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_vendor_id_fkey;
ALTER TABLE trucks DROP CONSTRAINT IF EXISTS trucks_owned_by_check;
ALTER TABLE trucks
  DROP COLUMN IF EXISTS owned_by,
  DROP COLUMN IF EXISTS vendor_id;

-- 4. users role check: remove 'vendor'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  (role)::text = ANY (ARRAY[
    'admin','general_manager','fleet_manager','operations_manager',
    'accountant','client','driver','it_admin'
  ])
);

-- 5. drop vendors table (now unreferenced)
DROP TABLE IF EXISTS vendors;
