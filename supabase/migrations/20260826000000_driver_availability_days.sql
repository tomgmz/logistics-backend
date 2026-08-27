-- Per-day availability the driver sets from the mobile app.
--
-- `drivers.status` answers "am I taking work right now"; this table answers
-- "which days of this month can I be given a delivery". The driver ticks the
-- days on the calendar behind the availability pill, and operations may only put
-- them on a booking whose schedule date they ticked.
--
-- A month with NO rows means the driver never filled that month in, which is
-- read as "no objection", not "unavailable" — otherwise every driver who already
-- opted in would drop out of the assignable pool the day this ships.
--
-- Rows for days that have already passed are kept: they are a record of what the
-- driver committed to, and the API only ever rewrites today onward.
-- Backend writes/reads with the service-role key, so no RLS policy is added.

create table if not exists public.driver_availability_days (
  availability_id uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references public.drivers(driver_id) on delete cascade,
  available_on    date not null,
  created_at      timestamptz not null default now(),
  unique (driver_id, available_on)
);

-- Reads are always "this driver, this month" (app) or "this driver, this day"
-- (the assignment gate), both served by the leading driver_id.
create index if not exists driver_availability_days_driver_day_idx
  on public.driver_availability_days (driver_id, available_on);
