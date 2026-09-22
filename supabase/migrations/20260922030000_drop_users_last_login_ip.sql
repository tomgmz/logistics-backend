-- The last stored user IP in the schema.
--
-- users.last_login_ip has no writer anywhere in src/ — it is a leftover from an
-- earlier login implementation — but unlike the dormant columns dropped in
-- 20260922020000 it still holds values for 2 of 15 users, captured before that
-- code was replaced.
--
-- Dropped for the same reason as the rest: the privacy rules do not allow
-- retaining where a user connected from, and an unwritten column holding stale
-- personal data is the worst of both worlds — nothing reads it, so nobody would
-- notice it was still there.
--
-- After this migration no table in the schema stores a user IP address.

ALTER TABLE users DROP COLUMN IF EXISTS last_login_ip;
