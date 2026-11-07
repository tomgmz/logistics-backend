-- Expiry reminders on the shared schedule (2026-11-07): 1 month, 3 weeks,
-- 2 weeks, 1 week, then 6..1 days before, and on the day. Each stage sent is
-- recorded per expiry date as "<expiry>|<stage>|<channel>" → sent at, the same
-- shape as drivers.license_reminders (20261101040000).
--
-- Plain jsonb columns, no foreign keys (nothing new for PostgREST to embed).

ALTER TABLE public.trucks
  ADD COLUMN IF NOT EXISTS registration_reminders jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS contract_reminders jsonb NOT NULL DEFAULT '{}'::jsonb;
