-- Drops three dormant ip_address columns found after the earlier IP removal.
--
-- active_sessions, login_history and otp_codes each carry an ip_address column
-- that nothing in the backend writes: a grep for ip_address across src/ returns
-- no writers, and the data agrees — 0 of 7 active_sessions rows, 0 of 222
-- login_history rows and 0 otp_codes rows hold a value.
--
-- Same reasoning as audit_logs.ip_address in 20260922000000: an empty PII
-- column that the privacy rules forbid populating is not harmless, because the
-- next person to touch these tables will read the column as an invitation.
-- Nothing is lost by removing them.
--
-- Per-IP rate limiting is unaffected: it lives in express-rate-limit's
-- in-memory store (middlewares/rateLimit.middleware.ts) and has never used
-- these columns.

ALTER TABLE active_sessions DROP COLUMN IF EXISTS ip_address;
ALTER TABLE login_history   DROP COLUMN IF EXISTS ip_address;
ALTER TABLE otp_codes       DROP COLUMN IF EXISTS ip_address;
