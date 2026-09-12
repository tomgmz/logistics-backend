import { BrevoClient, BrevoEnvironment } from '@getbrevo/brevo'
import crypto from 'crypto'

const APP_NAME          = process.env.APP_NAME             || 'Logistics'
const PHYSICAL_ADDRESS  = process.env.APP_PHYSICAL_ADDRESS || 'Blk. 6 Lot 8 Lynville Enclave, Mamatid, City of Cabuyao, Laguna'
const APP_SUPPORT_EMAIL = process.env.APP_SUPPORT_EMAIL    || process.env.BREVO_SENDER_EMAIL
const FROM_EMAIL        = process.env.BREVO_SENDER_EMAIL!
const FROM_NAME         = process.env.APP_NAME             || 'Logistics'

/**
 * Where the web app lives, for links we put in emails.
 *
 * `FRONTEND_URL` comes first because it is the variable this backend actually
 * sets; NEXT_PUBLIC_APP_URL and APP_URL are kept only as fallbacks for
 * deployments configured the other way. Getting this order wrong is not a
 * cosmetic problem — an unset base yields a host-less path like
 * "/reset-password?token=…", which Brevo's click tracker cannot resolve, so the
 * recipient lands on Brevo's 404 instead of our page and the email is wasted.
 *
 * Returns null rather than a placeholder so each caller decides what a missing
 * base means for it.
 */
function appBaseUrl(): string | null {
  const raw =
    process.env.FRONTEND_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    ''
  const trimmed = raw.trim().replace(/\/$/, '')
  return trimmed === '' ? null : trimmed
}

/**
 * Say at boot where emailed links will point.
 *
 * Worth a startup line because the failure mode is otherwise invisible until the
 * worst moment: an admin clicks "Send reset link" for someone locked out, and
 * only then does anyone discover the deploy has no app URL — or has a localhost
 * one that nobody but the developer can open. Neither is detectable from the
 * outside, so it gets said out loud alongside the CORS origins.
 */
export function reportEmailLinkBaseUrl(): void {
  const base = appBaseUrl()

  if (!base) {
    console.warn(
      '[email] No app URL configured (FRONTEND_URL / NEXT_PUBLIC_APP_URL / APP_URL). ' +
      'Password reset links CANNOT be sent until one is set.',
    )
    return
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$|\/)/i.test(base)
  if (isLocal && process.env.NODE_ENV === 'production') {
    console.warn(
      `[email] App URL is ${base} but NODE_ENV=production. ` +
      'Emailed links will only open on the machine running this server — set FRONTEND_URL to the public origin.',
    )
    return
  }

  console.log(`Email link base: ${base}`)
}

const ROLE_LABELS: Record<string, string> = {
  admin:      'Company Administrator',
  it_admin:         'IT Administrator',
  general_manager:  'General Manager',
  fleet_manager:      'Fleet Manager',
  operations_manager: 'Operations Manager',
  accountant:       'Accountant',
  driver:           'Driver',
  client:           'Client',
}

const UPPER  = 'ABCDEFGHJKLMNPQRSTUVWXYZ'  // no I, O
const LOWER  = 'abcdefghjkmnpqrstuvwxyz'    // no i, l, o
const DIGITS = '23456789'                   // no 0, 1

export function generateSecurePassword(): string {
  const pick = (charset: string, count: number): string[] =>
    Array.from({ length: count }, () =>
      charset[crypto.randomBytes(1)[0] % charset.length]
    )

  const chars = [
    ...pick(UPPER,  4),
    ...pick(LOWER,  6),
    ...pick(DIGITS, 4),
    // pad to 16 from combined pool
    ...pick(UPPER + LOWER + DIGITS, 2),
  ]

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}

function getBrevoClient(): BrevoClient {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not set')
  }
  return new BrevoClient({
    apiKey:      process.env.BREVO_API_KEY,
    environment: BrevoEnvironment.Default,
  })
}

export async function sendOtpEmail(
  to: string,
  code: string,
  firstName?: string | null
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const name = firstName ?? 'there'

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `${code} is your ${APP_NAME} verification code`,
      htmlContent: generateOtpEmailHtml(name, code),
      textContent: generateOtpEmailText(name, code),
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO EMAIL SEND ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    throw new Error(`Failed to send OTP email: ${error}`)
  }
}

export interface WelcomeEmailParams {
  to:        string
  firstName: string | null
  role:      string
  password:  string
}

export async function sendWelcomeEmail(params: WelcomeEmailParams): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, role, password } = params
  const name      = firstName ?? 'there'
  const roleLabel = ROLE_LABELS[role] ?? role.replace(/_/g, ' ')

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Welcome to ${APP_NAME} — Your account is ready`,
      htmlContent: generateWelcomeEmailHtml(name, to, roleLabel, password),
      textContent: generateWelcomeEmailText(name, to, roleLabel, password),
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO WELCOME EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    throw new Error(`Failed to send welcome email: ${error}`)
  }
}

export interface PasswordResetEmailParams {
  to:               string
  firstName:        string | null
  resetUrl:         string
  expiresInMinutes: number
}

/**
 * Build the absolute reset link for a token.
 *
 * Throws when no app base URL is configured. That is deliberate: a reset email
 * whose only purpose is a link must never go out with a broken one, because the
 * admin is then told "link sent", the request is marked as handled, and the
 * locked-out user waits on an email that leads nowhere.
 */
export function buildResetUrl(token: string): string {
  const base = appBaseUrl()
  if (!base) {
    throw new Error(
      'Cannot build a password reset link: set FRONTEND_URL (or NEXT_PUBLIC_APP_URL) ' +
      'to the web app origin, e.g. https://your-app.example.com',
    )
  }
  return `${base}/reset-password?token=${encodeURIComponent(token)}`
}

/**
 * The one-time reset link an administrator sends to a locked-out user.
 *
 * Note what is NOT in here: a password. The link carries a single-use token and
 * the user chooses their own password on the page, so nothing reusable is ever
 * sitting in an inbox.
 */
export async function sendPasswordResetEmail(
  params: PasswordResetEmailParams,
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, resetUrl, expiresInMinutes } = params
  const name = firstName ?? 'there'

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Reset your ${APP_NAME} password`,
      htmlContent: generatePasswordResetEmailHtml(name, resetUrl, expiresInMinutes),
      textContent: generatePasswordResetEmailText(name, resetUrl, expiresInMinutes),
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO PASSWORD RESET EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    throw new Error(`Failed to send password reset email: ${error}`)
  }
}

function generateOtpEmailHtml(name: string, code: string): string {
  const year = new Date().getFullYear()

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your ${APP_NAME} login code</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your one-time login code for ${APP_NAME} — expires in 5 minutes.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <tr>
                <td style="padding:40px 40px 20px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#1a1a1a;font-weight:700;">
                    ${APP_NAME}
                  </h1>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px;">
                  <hr style="border:none;border-top:1px solid #eeeeee;margin:0;">
                </td>
              </tr>

              <tr>
                <td style="padding:30px 40px 0 40px;">
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Here is your one-time login code for <strong>${APP_NAME}</strong>.
                    It expires in <strong>5 minutes</strong>.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="padding:20px 0;">
                        <table cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td style="background-color:#f4f4f5;border-radius:12px;padding:24px 48px;text-align:center;">
                              <span style="font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:bold;letter-spacing:12px;color:#1a1a1a;">
                                ${code}
                              </span>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 16px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.5;">
                          <strong>Never share this code.</strong> ${APP_NAME} will never ask for your code by phone or email.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.5;">
                    If you did not request this code, you can safely ignore this email.
                    Contact us at
                    <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#4f46e5;text-decoration:none;">${APP_SUPPORT_EMAIL}</a>
                    if you have concerns.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    © ${year} ${APP_NAME}. All rights reserved.
                  </p>
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    ${PHYSICAL_ADDRESS}
                  </p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    This is a transactional email sent because a login was requested for your account.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `
}

function generateOtpEmailText(name: string, code: string): string {
  const year = new Date().getFullYear()

  return `
Hi ${name},

Your ${APP_NAME} login code is:

${code}

This code expires in 5 minutes.

NEVER share this code with anyone. ${APP_NAME} will never ask for your code by phone or email.

If you did not request this code, you can safely ignore this email.
For concerns, contact us at ${APP_SUPPORT_EMAIL}.

---
© ${year} ${APP_NAME}. All rights reserved.
${PHYSICAL_ADDRESS}
  `.trim()
}

function generateWelcomeEmailHtml(
  name:      string,
  email:     string,
  roleLabel: string,
  password:  string,
): string {
  const year       = new Date().getFullYear()
  // Falls back to '#' only if nothing is configured — the credentials above are
  // still useful without a working button, so this one degrades rather than throws.
  const base       = appBaseUrl()
  const loginUrl   = base ? `${base}/` : '#'

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to ${APP_NAME}</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your ${APP_NAME} account has been created — sign in with the credentials inside.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <!-- Header -->
              <tr>
                <td style="background-color:#0a0a0a;padding:32px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">
                    ${APP_NAME}
                  </h1>
                  <p style="margin:6px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">
                    Account Credentials
                  </p>
                </td>
              </tr>

              <!-- Greeting -->
              <tr>
                <td style="padding:32px 40px 0 40px;">
                  <p style="margin:0 0 12px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    An account has been created for you on <strong>${APP_NAME}</strong> as a
                    <strong>${roleLabel}</strong>.
                  </p>
                  <p style="margin:0 0 28px 0;font-family:Arial,sans-serif;font-size:15px;color:#555555;line-height:1.6;">
                    Use the credentials below to sign in. You can sign in with either your password
                    or a one-time email code — both options are available on the login screen.
                  </p>
                </td>
              </tr>

              <!-- Credentials card -->
              <tr>
                <td style="padding:0 40px 28px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0"
                    style="background-color:#f8f8f8;border-radius:10px;border:1px solid #e8e8e8;">
                    <tr>
                      <td style="padding:24px 28px;">
                        <p style="margin:0 0 4px 0;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                          letter-spacing:0.14em;text-transform:uppercase;color:#999999;">
                          Email address
                        </p>
                        <p style="margin:0 0 20px 0;font-family:'Courier New',Courier,monospace;font-size:15px;
                          color:#1a1a1a;word-break:break-all;">
                          ${email}
                        </p>

                        <p style="margin:0 0 4px 0;font-family:Arial,sans-serif;font-size:10px;font-weight:700;
                          letter-spacing:0.14em;text-transform:uppercase;color:#999999;">
                          Temporary password
                        </p>
                        <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:22px;
                          font-weight:bold;letter-spacing:4px;color:#1a1a1a;word-break:break-all;">
                          ${password}
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Warning -->
              <tr>
                <td style="padding:0 40px 28px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 16px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.5;">
                          <strong>This is a temporary password.</strong>
                          Please change it after your first login for security.
                          Never share your password with anyone — ${APP_NAME} staff will never ask for it.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 36px 40px;" align="center">
                  <a href="${loginUrl}"
                    style="display:inline-block;background-color:#0a0a0a;color:#ffffff;
                      font-family:Arial,sans-serif;font-size:14px;font-weight:700;
                      text-decoration:none;padding:14px 36px;border-radius:8px;
                      letter-spacing:0.08em;">
                    Sign In Now
                  </a>
                </td>
              </tr>

              <!-- Help -->
              <tr>
                <td style="padding:0 40px 32px 40px;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.6;">
                    Having trouble signing in? Contact your administrator or reach us at
                    <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#4f46e5;text-decoration:none;">
                      ${APP_SUPPORT_EMAIL}
                    </a>.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    © ${year} ${APP_NAME}. All rights reserved.
                  </p>
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    ${PHYSICAL_ADDRESS}
                  </p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    This email was sent because an administrator created an account for you.
                    If this was a mistake, contact us immediately.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `
}

function generateWelcomeEmailText(
  name:      string,
  email:     string,
  roleLabel: string,
  password:  string,
): string {
  const year     = new Date().getFullYear()
  const base     = appBaseUrl()
  const loginUrl = base ? `${base}/` : ''

  return `
Hi ${name},

An account has been created for you on ${APP_NAME} as a ${roleLabel}.

── YOUR LOGIN CREDENTIALS ──────────────────
Email:    ${email}
Password: ${password}
────────────────────────────────────────────

Sign in at: ${loginUrl}

IMPORTANT: This is a temporary password. Please change it after your first login.
Never share your password with anyone — ${APP_NAME} staff will never ask for it.

You can also sign in using a one-time email code instead of a password — both options
are available on the login screen.

Need help? Contact us at ${APP_SUPPORT_EMAIL}.

---
© ${year} ${APP_NAME}. All rights reserved.
${PHYSICAL_ADDRESS}
This email was sent because an administrator created an account for you.
  `.trim()
}

function generatePasswordResetEmailHtml(
  name:     string,
  resetUrl: string,
  minutes:  number,
): string {
  const year = new Date().getFullYear()

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset your ${APP_NAME} password</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your administrator sent you a link to set a new ${APP_NAME} password — it expires in ${minutes} minutes.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <!-- Header -->
              <tr>
                <td style="background-color:#0a0a0a;padding:32px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">
                    ${APP_NAME}
                  </h1>
                  <p style="margin:6px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">
                    Password Reset
                  </p>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:32px 40px 0 40px;">
                  <p style="margin:0 0 12px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Your administrator has approved your password reset request.
                  </p>
                  <p style="margin:0 0 28px 0;font-family:Arial,sans-serif;font-size:15px;color:#555555;line-height:1.6;">
                    Use the button below to choose a new password. This link works
                    <strong>once</strong> and expires in <strong>${minutes} minutes</strong>.
                    Setting a new password also unlocks your account.
                  </p>
                </td>
              </tr>

              <!-- CTA -->
              <tr>
                <td style="padding:0 40px 28px 40px;" align="center">
                  <a href="${resetUrl}"
                    style="display:inline-block;background-color:#0a0a0a;color:#ffffff;
                      font-family:Arial,sans-serif;font-size:14px;font-weight:700;
                      text-decoration:none;padding:14px 36px;border-radius:8px;
                      letter-spacing:0.08em;">
                    Set A New Password
                  </a>
                </td>
              </tr>

              <!-- Plain-text fallback link -->
              <tr>
                <td style="padding:0 40px 28px 40px;">
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:13px;color:#777777;line-height:1.6;">
                    If the button does not work, paste this into your browser:
                  </p>
                  <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:12px;color:#4f46e5;word-break:break-all;">
                    ${resetUrl}
                  </p>
                </td>
              </tr>

              <!-- Warning -->
              <tr>
                <td style="padding:0 40px 28px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 16px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.5;">
                          <strong>Do not forward this email.</strong>
                          Anyone with this link can set your password until it is used or expires.
                          If you did not ask for a reset, contact your administrator immediately.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Help -->
              <tr>
                <td style="padding:0 40px 32px 40px;">
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.6;">
                    Link expired? Request another reset from the sign-in screen, or reach us at
                    <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#4f46e5;text-decoration:none;">
                      ${APP_SUPPORT_EMAIL}
                    </a>.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    © ${year} ${APP_NAME}. All rights reserved.
                  </p>
                  <p style="margin:0 0 6px 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    ${PHYSICAL_ADDRESS}
                  </p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;">
                    This is a transactional email sent because a password reset was approved for your account.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `
}

function generatePasswordResetEmailText(
  name:     string,
  resetUrl: string,
  minutes:  number,
): string {
  const year = new Date().getFullYear()

  return `
Hi ${name},

Your administrator has approved your password reset request.

Open this link to choose a new password:

${resetUrl}

This link works ONCE and expires in ${minutes} minutes. Setting a new password also
unlocks your account.

DO NOT FORWARD THIS EMAIL. Anyone with this link can set your password until it is
used or expires. If you did not ask for a reset, contact your administrator immediately.

Link expired? Request another reset from the sign-in screen, or reach us at ${APP_SUPPORT_EMAIL}.

---
© ${year} ${APP_NAME}. All rights reserved.
${PHYSICAL_ADDRESS}
This is a transactional email sent because a password reset was approved for your account.
  `.trim()
}