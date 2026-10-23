-- Vehicle types, managed on System Maintenance.
--
-- Until now the list (Closed Van, Wing Van, ...) was hard-coded in the web
-- model form, with an "Others" box for anything else. It now lives here, and
-- the three places that ask for a type read it:
--   - the truck model form (Vehicle Management → Models)
--   - the vehicle form's type filter over the model picker
--   - the vendor-supplied vehicle on the "Choose vehicle and driver" pop-up
--
-- truck_models.vehicle_type stays a text column holding the type's NAME, so
-- every existing reader (booking details, mobile, transaction history) keeps
-- working untouched. Renaming a type rewrites that text on the models in the
-- same transaction (see vehicle-type.service.ts). Bookings and deliveries keep
-- the name they were given (truck_type_needed, vendor_vehicle_type): those are
-- snapshots of what was true at the time and are never rewritten.
--
-- A type in use by a non-archived model cannot be deleted; it can be made
-- inactive instead, which hides it from the pickers but leaves those models
-- as they are.

CREATE TABLE IF NOT EXISTS public.vehicle_types (
  vehicle_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(60)  NOT NULL,
  description     varchar(300),
  is_active       boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_types_name_not_blank CHECK (btrim(name) <> '')
);

-- "Wing Van" and "wing van" are the same type.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_types_name_ci_key
  ON public.vehicle_types (lower(btrim(name)));

ALTER TABLE public.vehicle_types ENABLE ROW LEVEL SECURITY;
-- No policies: only the backend (service role / pool) reads or writes it.

-- The old hard-coded list, then every type a model already carries (the
-- "Others" free text), so no existing model points at a missing type.
INSERT INTO public.vehicle_types (name)
SELECT v.name
  FROM (VALUES ('Closed Van'), ('Wing Van'), ('Dropside'),
               ('Refrigerated Van'), ('Boom Truck'), ('Flatbed')) AS v(name)
ON CONFLICT DO NOTHING;

INSERT INTO public.vehicle_types (name)
SELECT DISTINCT ON (lower(btrim(tm.vehicle_type))) left(btrim(tm.vehicle_type), 60)
  FROM public.truck_models tm
 WHERE tm.vehicle_type IS NOT NULL AND btrim(tm.vehicle_type) <> ''
ORDER BY lower(btrim(tm.vehicle_type)), tm.vehicle_type
ON CONFLICT DO NOTHING;

-- Live table signal, same topic as the rest of System Maintenance.
DROP TRIGGER IF EXISTS live_signal ON public.vehicle_types;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.vehicle_types
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('vehicle_type_id', 'live:catalog');
