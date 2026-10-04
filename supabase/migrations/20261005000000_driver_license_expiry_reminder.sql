-- One-month-ahead reminder to a driver that their licence is about to expire.
--
-- Each stamp holds the EXPIRY DATE the reminder went out for, not when it was
-- sent. A renewal writes a new license_expiry, the stamp stops matching, and the
-- driver is reminded again a month before the new date — no reset step needed.
--
-- Two stamps because the two channels fail independently: the in-app row (plus
-- push) and the email are each retried on the next tick until they land, and a
-- Brevo outage must not resend the in-app notification every hour.
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS license_reminder_notified_for date,
  ADD COLUMN IF NOT EXISTS license_reminder_emailed_for  date;
