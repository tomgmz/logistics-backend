-- Make POST /booking safe to retry.
--
-- The client uploads its transaction documents, then creates the booking. If
-- that second call timed out client-side the user simply pressed the button
-- again — and with route optimisation formerly able to hang the request
-- indefinitely, that was a realistic way to end up with the same trip booked
-- twice. Nothing in the row is naturally unique (same client, same route, same
-- day is a legitimate repeat booking), so the client now mints a key per
-- booking attempt and reuses it across retries.
--
-- Partial index: historical rows and any non-client caller carry NULL, and NULLs
-- do not conflict with each other, so only real keys are constrained.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_idempotency_key
  ON public.bookings (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.bookings.idempotency_key IS
  'Client-supplied key for one booking attempt. Retries of the same attempt reuse it and return the original booking rather than creating a second one.';
