-- Passkey storage.
--
-- The WebAuthn user handle is deliberately NOT users.user_id and never the
-- email. The handle is returned verbatim by the authenticator in a
-- discoverable-credential assertion, so anything meaningful in it leaks. A
-- random 32-byte opaque value identifies the account to us and says nothing to
-- anyone else.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS webauthn_user_handle bytea UNIQUE;

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  credential_pk      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,

  -- base64url of the raw credential ID. Globally unique: a credential must never
  -- resolve to two accounts.
  credential_id      text NOT NULL UNIQUE,
  public_key         bytea NOT NULL,

  -- Signature counter. 0 is legitimate AND PERMANENT for synced passkeys (Google
  -- Password Manager, iCloud Keychain), which is what nearly every driver will
  -- have. That is why the regression check in the service is conditional on a
  -- non-zero stored counter rather than a flat "must increase".
  counter            bigint NOT NULL DEFAULT 0,

  transports         text[] NOT NULL DEFAULT '{}',
  aaguid             text,
  credential_type    text NOT NULL DEFAULT 'public-key',

  -- Captured at registration so that triaging a lockout later can distinguish a
  -- synced credential (recoverable on a new phone) from a device-bound one
  -- (gone with the phone).
  backup_eligible    boolean NOT NULL DEFAULT false,
  backup_state       boolean NOT NULL DEFAULT false,

  -- The RP ID this credential was minted under, stored per row rather than
  -- assumed from config. RP ID is baked permanently into a credential; if it
  -- ever changes, stale rows must stop being offered rather than fail
  -- verification with an error nobody can interpret.
  rp_id              text NOT NULL,

  device_label       text,
  last_used_at       timestamptz,

  -- Soft revoke, so a revoked credential still RESOLVES and can fail with
  -- "revoked" instead of "unknown credential" -- and so offboarding leaves a
  -- trail.
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  revoked_reason     text,

  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx
  ON public.webauthn_credentials (user_id) WHERE revoked_at IS NULL;

-- Service-role only, matching every other table the API owns outright: RLS on so
-- a leaked anon key reaches nothing, no policies because nothing should reach it
-- except the backend.
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
