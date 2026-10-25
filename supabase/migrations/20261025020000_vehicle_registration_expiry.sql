-- Vehicle registration (LTO) validity.
--
-- registration_expiry is the last day the vehicle's registration is valid. It is
-- entered when the vehicle is created and changed on Update Details when it is
-- renewed. An expired registration blocks assignment; the vehicles that existed
-- before this column have it NULL, which is flagged on Upkeep but not blocked,
-- so operations do not stop while the dates are filled in.
--
-- The two reminder stamps work like drivers.license_reminder_*_for: each holds
-- the EXPIRY DATE the one-month-ahead reminder went out for, so a renewal (a new
-- date) re-arms the reminder with no reset step. Two stamps because the in-app
-- notification and the email fail independently.
ALTER TABLE public.trucks
  ADD COLUMN IF NOT EXISTS registration_expiry               date,
  ADD COLUMN IF NOT EXISTS registration_reminder_notified_for date,
  ADD COLUMN IF NOT EXISTS registration_reminder_emailed_for  date;
