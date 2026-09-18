/**
 * Passkey (WebAuthn) configuration.
 *
 * The RP ID is the one genuinely irreversible decision in this feature. It is
 * cryptographically bound into every credential at creation: change it and every
 * passkey ever enrolled becomes unusable, with no migration and no fallback —
 * every driver has to enrol again from a fresh invite.
 *
 * So it is read from the environment and never defaulted. A missing RP ID is a
 * hard failure in production rather than a quiet fallback to localhost, because
 * the alternative is enrolling real drivers against a hostname you are going to
 * throw away.
 */

/** The Relying Party ID: the registrable domain, e.g. '8338logistics.ph'. */
export const RP_ID = (process.env.WEBAUTHN_RP_ID ?? '').trim()

/** Shown in the OS passkey prompt, so it should read as the business, not the app slug. */
export const RP_NAME = (process.env.WEBAUTHN_RP_NAME ?? '8338 Logistics').trim()

/**
 * Origins a passkey ceremony may legitimately come from.
 *
 * Native Android does NOT send an https origin. It sends
 * `android:apk-key-hash:<base64url-sha256-of-the-signing-certificate>`, so this
 * list holds one entry per signing certificate that will ever sign the app —
 * the EAS/internal build key and the Play App Signing key are different, and an
 * app signed by a key that is missing here fails verification with an error that
 * gives no hint as to why. This is the single most common reason a passkey
 * integration works in testing and breaks in production.
 *
 * The https origin is included for a future web enrolment path; it is harmless
 * until then.
 */
export const ALLOWED_ORIGINS: string[] = (process.env.WEBAUTHN_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

/** Are passkeys configured well enough to run a ceremony at all? */
export function isPasskeyConfigured(): boolean {
  return RP_ID !== '' && ALLOWED_ORIGINS.length > 0
}

/**
 * Throw if a ceremony is attempted without usable configuration.
 *
 * Better a clear 503 than a verification failure that reads like the driver's
 * phone is at fault.
 */
export function assertPasskeyConfigured(): void {
  const fail = (detail: string) => {
    const err = new Error(`Passkey sign-in is not configured on this server (${detail}).`)
    // Tagged so controllers can answer 503 rather than a bare 500. Without this
    // a server missing its RP ID reports the same vague failure as a bad token,
    // and the operator debugging it has no way to tell which they are looking at
    // — which is the exact confusion this config guard exists to prevent.
    ;(err as any).code = 'PASSKEY_NOT_CONFIGURED'
    return err
  }

  if (RP_ID === '') throw fail('WEBAUTHN_RP_ID is unset')
  if (ALLOWED_ORIGINS.length === 0) throw fail('WEBAUTHN_ALLOWED_ORIGINS is empty')
}

/**
 * Say at boot what passkeys are pointed at, in the same spirit as the email link
 * base URL check: the failure mode is otherwise invisible until a driver is
 * standing next to a truck unable to sign in.
 */
export function reportWebauthnConfig(): void {
  const production = process.env.NODE_ENV === 'production'

  if (RP_ID === '') {
    const message = 'WEBAUTHN_RP_ID is not set — passkey enrolment and sign-in are disabled.'
    if (production) {
      // Not fatal on its own: the rest of the API is fine and company drivers
      // still sign in. But it must be loud, because nothing else will say it.
      console.error(`[webauthn] ${message}`)
    } else {
      console.warn(`[webauthn] ${message}`)
    }
    return
  }

  if (production && (RP_ID === 'localhost' || RP_ID.endsWith('.local'))) {
    throw new Error(
      `[webauthn] Refusing to start: WEBAUTHN_RP_ID is "${RP_ID}" in production. ` +
      `Every passkey enrolled against it would be permanently useless.`,
    )
  }

  if (ALLOWED_ORIGINS.length === 0) {
    console.error(
      '[webauthn] WEBAUTHN_RP_ID is set but WEBAUTHN_ALLOWED_ORIGINS is empty — ' +
      'every ceremony will fail on origin verification.',
    )
    return
  }

  console.log(`[webauthn] RP ID ${RP_ID} · ${ALLOWED_ORIGINS.length} allowed origin(s)`)
}

/** How long a challenge stays usable. A ceremony takes seconds; the rest is attack surface. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** How long an enrolment invite stays usable. Long enough to install the app mid-run. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000

/** Attempts against a single invite before it is torn down. */
export const MAX_INVITE_ATTEMPTS = 5
