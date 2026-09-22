-- Removes the last two places a user's IP address was stored.
--
-- Follows 20260922000000, which dropped audit_logs.ip_address. These two were
-- left behind at the time because, unlike that column, they held real values
-- and looked like anti-abuse controls worth keeping.
--
-- They are not. Both were write-only: nothing in the codebase ever read
-- requested_ip or created_ip back. The actual per-IP throttling on these
-- endpoints is resetRequestIpLimiter / passkeyAuthLimiter in
-- middlewares/rateLimit.middleware.ts, which key off express-rate-limit's own
-- in-memory store and never persist anything. Dropping these columns therefore
-- costs no rate limiting — it only stops retaining personal data the privacy
-- rules do not allow us to keep.
--
-- The code that populated them was removed first, so these columns have been
-- receiving nulls since that change.

-- 8 rows held a value at the time of writing.
ALTER TABLE password_reset_requests DROP COLUMN IF EXISTS requested_ip;

-- 23 rows held a value at the time of writing. Challenges are short-lived and
-- burned on use, so most of these were already expired rows.
ALTER TABLE webauthn_challenges DROP COLUMN IF EXISTS created_ip;
