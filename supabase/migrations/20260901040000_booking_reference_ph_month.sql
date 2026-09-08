-- Make the booking reference mean what it looks like.
--
-- `BK-202608-00042` reads as "the 42nd booking of August 2026". It was neither:
--
--  1. The month came from `TO_CHAR(NOW(), 'YYYYMM')` and this database runs in
--     UTC, while the business runs in Manila. Every booking made between
--     midnight and 08:00 PHT on the 1st of a month was stamped with the PREVIOUS
--     month — the reference people quote on the phone, wrong, eight hours a
--     month.
--  2. The counter was a single global sequence that never reset, so the suffix
--     was the count of every booking ever taken, not the count for that month.
--
-- The counter is now per-month and kept in a table rather than a sequence: the
-- upsert takes a row lock for the month, which serialises concurrent inserts
-- without a sequence that would need resetting on a schedule.
--
-- Existing references are seeded in below, so numbering continues from where
-- each month actually left off rather than restarting and colliding with a
-- reference already issued (`bookings_reference_number_key` would reject it,
-- which is the right backstop but a poor first line of defence).

CREATE TABLE IF NOT EXISTS public.booking_reference_counters (
  period     text    PRIMARY KEY,   -- 'YYYYMM', in Philippine time
  last_value integer NOT NULL DEFAULT 0
);

ALTER TABLE public.booking_reference_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_reference_counters_service_role ON public.booking_reference_counters;
CREATE POLICY booking_reference_counters_service_role
  ON public.booking_reference_counters
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed from what has already been issued: highest suffix seen per period.
INSERT INTO public.booking_reference_counters (period, last_value)
SELECT
  substring(reference_number from 4 for 6)                AS period,
  MAX((substring(reference_number from 11))::integer)     AS last_value
FROM public.bookings
WHERE reference_number ~ '^BK-[0-9]{6}-[0-9]+$'
GROUP BY 1
ON CONFLICT (period) DO UPDATE
  SET last_value = GREATEST(public.booking_reference_counters.last_value, EXCLUDED.last_value);

CREATE OR REPLACE FUNCTION public.generate_booking_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  ph_period text;
  next_value integer;
BEGIN
  -- The calendar the business actually works to, not the server's.
  ph_period := TO_CHAR(NOW() AT TIME ZONE 'Asia/Manila', 'YYYYMM');

  INSERT INTO public.booking_reference_counters AS c (period, last_value)
  VALUES (ph_period, 1)
  ON CONFLICT (period) DO UPDATE SET last_value = c.last_value + 1
  RETURNING c.last_value INTO next_value;

  NEW.reference_number := 'BK-' || ph_period || '-' || LPAD(next_value::TEXT, 5, '0');
  RETURN NEW;
END;
$function$;
