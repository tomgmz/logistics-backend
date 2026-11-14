-- Refresh-token rotation (2026-11-14).
--
-- Every refresh now hands out a NEW refresh token and retires the one that was
-- sent (RFC 9700 §4.14; Auth0 / Okta "rotation with reuse detection"). The row
-- keeps:
--   previous_refresh_token      hash of the token just retired, so a repeat of
--                               it inside the grace period (a reply lost on weak
--                               signal, two tabs at once) gets the SAME new token
--                               back instead of being called theft;
--   refresh_rotated_at          when that happened (starts the grace period);
--   rotated_refresh_token_enc   the new token, AES-256-GCM sealed with a key only
--                               the server holds, so that repeat can be answered.
--                               A database copy still holds no usable token.
-- A retired token used after the grace period ends every session of the account
-- with revoked_reason 'refresh_reuse'.
--
-- No foreign keys are added (no PostgREST embed can become ambiguous).

ALTER TABLE public.active_sessions
  ADD COLUMN IF NOT EXISTS previous_refresh_token    text,
  ADD COLUMN IF NOT EXISTS refresh_rotated_at        timestamptz,
  ADD COLUMN IF NOT EXISTS rotated_refresh_token_enc text;

-- Refresh lookups go by hash; neither column had an index.
CREATE INDEX IF NOT EXISTS idx_active_sessions_refresh_token
  ON public.active_sessions (refresh_token);

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
    'credentials_revoked',
    'refresh_reuse'
  ));
