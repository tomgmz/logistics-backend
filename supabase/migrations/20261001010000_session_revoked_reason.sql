-- Why a session ended, so the device holding it can be told.
--
-- Signing in revokes every other session the account has (one active session
-- per user). The device that lost its session only ever saw a generic 401 and
-- was dropped on the landing page with "You have been signed out" — which reads
-- like a timeout, not like "someone just signed in to your account elsewhere".
--
-- Revocation stamps the reason on the row; the token hash stays on it, so a
-- refused request can look the row up and answer with a specific code. NULL
-- means the session simply expired or predates this column.

ALTER TABLE public.active_sessions
  ADD COLUMN IF NOT EXISTS revoked_reason text;

ALTER TABLE public.active_sessions
  DROP CONSTRAINT IF EXISTS active_sessions_revoked_reason_check;

ALTER TABLE public.active_sessions
  ADD CONSTRAINT active_sessions_revoked_reason_check
  CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'signed_in_elsewhere',
    'logout',
    'logout_all',
    'password_reset',
    'deactivated',
    'credentials_revoked'
  ));
