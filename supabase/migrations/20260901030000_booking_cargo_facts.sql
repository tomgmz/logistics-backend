-- Cargo facts the wizard already collects but the booking never kept.
--
-- 1. NET WEIGHT. The palletized form asks for net weight per pallet, validates
--    it against gross, totals it, and shows it on screen — then dropped it at
--    submit, because there was nowhere to put it. Net is what a consignee
--    reconciles a delivery receipt against, so it belongs on the booking.
--
-- 2. STACKABILITY. `stackable_required` was set true whenever ANY pallet could
--    be stacked, which is backwards: a pallet that stacks is an opportunity, a
--    pallet that cannot is the constraint. It was also never set at all for
--    loose cargo, whose groups carry their own `nonStackable` flag. Rather than
--    silently redefine a column that historical rows already populated under the
--    old meaning, the real constraint gets its own column and the old one is
--    left to the rows that used it.
--
-- 3. DENSITY. Generated, not stored by the client: it is exactly gross weight
--    over volume, and a column the API could set independently is a column that
--    can contradict the two numbers it comes from. Postgres computes it.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS required_net_weight_kg numeric,
  ADD COLUMN IF NOT EXISTS non_stackable_cargo    boolean;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS cargo_density_kg_cbm numeric
  GENERATED ALWAYS AS (required_weight_kg / NULLIF(required_volume_cbm, 0)) STORED;

COMMENT ON COLUMN public.bookings.required_net_weight_kg IS
  'Total net (product-only) weight for palletized cargo. Gross is what the truck carries; net is what the consignee receives.';
COMMENT ON COLUMN public.bookings.non_stackable_cargo IS
  'True when any part of the load must not be stacked. Supersedes stackable_required, which was set with the opposite sense and never populated for loose cargo.';
COMMENT ON COLUMN public.bookings.cargo_density_kg_cbm IS
  'Generated: required_weight_kg / required_volume_cbm. Predicts whether a load weighs out or cubes out.';
