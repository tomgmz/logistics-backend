-- License expiry reminders in three stages (2026-11-01): one month, 7 days and
-- on the expiry day, to the driver (in-app + email), to every Company
-- Administrator and Operations Manager (in-app), and to the 8338 inbox (email).
--
-- What has gone out, per expiry date: keys "<expiry>|<stage>|<channel>" with
-- the time sent. A renewal changes the expiry, so nothing matches and the new
-- date gets its own reminders. The driver's one-month reminder keeps using
-- license_reminder_notified_for / _emailed_for, so nothing already sent repeats.
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS license_reminders jsonb NOT NULL DEFAULT '{}'::jsonb;
