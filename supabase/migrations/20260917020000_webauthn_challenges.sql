-- WebAuthn challenges.
--
-- These live in Postgres rather than a process-local Map. The backend is not
-- guaranteed to stay single-instance, and an in-memory challenge store turns a
-- horizontal scale-out into an intermittent "challenge not found" that only
-- reproduces under load and looks like a client bug.
CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  challenge_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- sha256(challenge + TOKEN_PEPPER), via the same hashToken() already used for
  -- session and reset tokens. The plaintext exists only in the options payload
  -- on its way to the device.
  challenge_hash text NOT NULL UNIQUE,

  purpose        text NOT NULL CHECK (purpose IN ('registration', 'authentication')),

  -- Null for a discoverable-credential authentication: the whole point is that
  -- the server does not know who is signing in until the assertion arrives.
  user_id        uuid REFERENCES public.users(user_id) ON DELETE CASCADE,

  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_ip     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Supports both the consumption lookup and the expiry sweep.
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx
  ON public.webauthn_challenges (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
