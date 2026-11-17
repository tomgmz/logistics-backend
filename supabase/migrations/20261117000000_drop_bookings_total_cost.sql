-- The system handles no amounts, cash or payments (user 2026-11-17).
-- bookings.total_cost had no writer since reverse billing was removed
-- (2026-09-24) and no reader since 2026-11-17. Checked on production
-- 2026-11-17: 0 rows hold a figure; no view, function, trigger, index or
-- constraint references it.
--
-- DEPLOY ORDER: the backend that no longer selects total_cost
-- (BOOKING_WITH_RELATIONS_SELECT, transaction history) must be live first,
-- or every booking read fails with "column bookings.total_cost does not exist".
alter table public.bookings drop column if exists total_cost;
