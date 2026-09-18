-- Passkey enrollment invites for external drivers.
--
-- A NEW table rather than a reuse of password_reset_requests, for three reasons
-- that each rule it out on their own:
--   * its unique index is "one open request per user", while an external driver
--     legitimately needs a fresh invite per booking;
--   * its handler_group / queue semantics are about an admin working a list,
--     which has no analogue here;
--   * completing one of its tokens SETS A PASSWORD -- exactly what must never
--     happen to an account whose entire point is that it has no usable password.
--
-- The token mechanics are copied wholesale from that flow, because they are
-- sound: randomBytes(32).base64url, only the hash at rest, single consumption.
CREATE TABLE IF NOT EXISTS public.driver_enrollment_invites (
  invite_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,

  -- The booking this invite was raised for. The delivery's vendor snapshot stays
  -- the record of the engagement; this is the record of why the account exists.
  booking_id  uuid REFERENCES public.bookings(booking_id) ON DELETE SET NULL,

  -- Snapshot of the address it was sent to, so a later edit to users.email does
  -- not rewrite history about where the invite actually went.
  email       text NOT NULL,

  token_hash  text NOT NULL,

  -- 72 hours, not the reset flow's 60 minutes. A reset link is clicked by someone
  -- actively locked out and waiting; an invite is read by a subcontractor who may
  -- be mid-run and still has to install the app first. It also carries strictly
  -- less power than a reset token -- it authorises ADDING A PASSKEY, not setting
  -- a password -- so the longer window is proportionate.
  expires_at  timestamptz NOT NULL,

  status      text NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'consumed', 'expired', 'revoked')),
  consumed_at timestamptz,

  -- A 256-bit token is not realistically guessable; this exists to catch a replay
  -- storm and to tear the invite down rather than let it be hammered.
  attempts    int NOT NULL DEFAULT 0,

  sent_by     uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_enrollment_invites_token_idx
  ON public.driver_enrollment_invites (token_hash);

CREATE INDEX IF NOT EXISTS driver_enrollment_invites_open_idx
  ON public.driver_enrollment_invites (user_id) WHERE status = 'sent';

ALTER TABLE public.driver_enrollment_invites ENABLE ROW LEVEL SECURITY;
