-- The driver's call time gets its own date (user 2026-11-17). A booking that
-- starts at 12:00 AM on Nov 12 may need the driver at the pickup at 10:00 PM
-- on Nov 11; a time alone was always read as the booking day.
--
-- driver_call_date + driver_call_time (PH time) = the call instant. NULL date
-- with a time set (older backend) = the booking day. Additive: the running
-- backend ignores the column. No FK (plain date).
alter table public.bookings add column if not exists driver_call_date date;

update public.bookings
   set driver_call_date = schedule_date
 where driver_call_time is not null
   and driver_call_date is null;

comment on column public.bookings.driver_call_date is
  'Day of the driver''s call time (PH). Booking day or the day before; the call instant may not be after schedule_date + call_time.';
