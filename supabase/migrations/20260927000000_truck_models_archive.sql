-- Truck models are archived, not deleted.
--
-- Deleting a model used to hard-delete the catalog row, which silently stripped
-- the model (and with it the vehicle type, capacity and image) from every truck
-- and every historical booking that joined through it. Archiving keeps the row
-- for those joins and only hides the model from the catalog and the vehicle
-- form's model picker.
--
-- The backend treats a missing column as "nothing archived" so the catalog keeps
-- working until this is applied; only the Archive action itself needs it.
ALTER TABLE public.truck_models
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.truck_models.archived_at IS
  'When the model was archived from Vehicle Management. NULL = in the catalog. Archived models stay joinable from trucks and bookings.';
