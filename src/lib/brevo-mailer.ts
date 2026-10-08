import { BrevoClient, BrevoEnvironment } from '@getbrevo/brevo'
import crypto from 'crypto'
import { logSystem } from './log-system.js'

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
  driver:           'Driver',
  client:           'Client',
}

/**
 * The one footer every email uses: grey band, three centred lines. Each email
 * passes only its own "why you got this" sentence, so the design cannot drift.
 */
function emailFooterHtml(reason: string): string {
  const year = new Date().getFullYear()
  const line = 'font-family:Arial,sans-serif;font-size:12px;color:#999999;text-align:center;line-height:1.5;'
  return `
              <tr>
                <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:0 0 6px 0;${line}">&copy; ${year} ${APP_NAME}. All rights reserved.</p>
                  <p style="margin:0 0 6px 0;${line}">${PHYSICAL_ADDRESS}</p>
                  <p style="margin:0;${line}">${reason}</p>
                </td>
              </tr>`
}

function emailFooterText(reason: string): string {
  const year = new Date().getFullYear()
  return `© ${year} ${APP_NAME}. All rights reserved.\n${PHYSICAL_ADDRESS}\n${reason}`
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
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send OTP email: ${error}`,
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
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send welcome email: ${error}`,
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
 * Always an https link to the web page, whoever it is for. An email client
 * cannot be relied on to follow a custom scheme, and the phone reading the mail
 * may not have the app installed, so the web page is the one destination that
 * always resolves.
 *
 * For a driver it carries `?app=1`, which tells that page to hand off to the
 * mobile app rather than ask for the password itself. Drivers never touch the
 * web app otherwise — they are handed a phone and that is the whole of their
 * software — so finishing the reset in a browser was the odd step out. The flag
 * is a routing hint and nothing more: it grants nothing, and the token is still
 * the only credential involved.
 *
 * Throws when no app base URL is configured. That is deliberate: a reset email
 * whose only purpose is a link must never go out with a broken one, because the
 * admin is then told "link sent", the request is marked as handled, and the
 * locked-out user waits on an email that leads nowhere.
 */
export function buildResetUrl(token: string, role?: string | null): string {
  const base = appBaseUrl()
  if (!base) {
    throw new Error(
      'Cannot build a password reset link: set FRONTEND_URL (or NEXT_PUBLIC_APP_URL) ' +
      'to the web app origin, e.g. https://your-app.example.com',
    )
  }
  const appHandoff = role === 'driver' ? '&app=1' : ''
  return `${base}/reset-password?token=${encodeURIComponent(token)}${appHandoff}`
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
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send password reset email: ${error}`,
    })
    throw new Error(`Failed to send password reset email: ${error}`)
  }
}

/**
 * What a code is for, in the words the email uses.
 *
 * The OTP templates were written for sign-in and said so in five places. A reset
 * code is the same object with a different reason and a different life, so the
 * reason and the life became parameters rather than a second copy of the layout
 * that would drift from this one the first time the footer changed.
 */
interface OtpCopy {
  // Subject-line and title noun, e.g. 'login code' / 'password reset code'.
  noun:    string
  // The sentence above the digits.
  intro:   string
  // Why this email is transactional, for the footer.
  because: string
  minutes: number
  // Small caption under the app name in the black header band.
  label:   string
}

const LOGIN_OTP_COPY: OtpCopy = {
  label:   'Sign-in Code',
  noun:    'login code',
  intro:   'Here is your one-time login code',
  because: 'a login was requested for your account',
  minutes: 5,
}

export interface PasswordResetOtpEmailParams {
  to:               string
  firstName:        string | null
  code:             string
  expiresInMinutes: number
}

/**
 * The reset code an IT Admin sends themselves.
 *
 * There is no link in here, and there is no password in here. The code proves the
 * person asking for the reset is reading the registered mailbox; the password is
 * chosen afterwards on a page this code opens, so nothing reusable is ever left
 * sitting in an inbox.
 *
 * Unlike sendPasswordResetEmail, this one needs no app base URL and so cannot be
 * defeated by a missing FRONTEND_URL - the recipient is already on the page that
 * will ask for the code.
 */
export async function sendPasswordResetOtpEmail(
  params: PasswordResetOtpEmailParams,
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, code, expiresInMinutes } = params
  const name = firstName ?? 'there'

  const copy: OtpCopy = {
    label:   'Password Reset Code',
    noun:    'password reset code',
    intro:   'Here is your one-time password reset code',
    because: 'a password reset was requested for your Administrator account',
    minutes: expiresInMinutes,
  }

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `${code} is your ${APP_NAME} password reset code`,
      htmlContent: generateOtpEmailHtml(name, code, copy),
      textContent: generateOtpEmailText(name, code, copy),
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO PASSWORD RESET OTP EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send password reset code email: ${error}`,
    })
    throw new Error(`Failed to send password reset code email: ${error}`)
  }
}

function generateOtpEmailHtml(name: string, code: string, copy: OtpCopy = LOGIN_OTP_COPY): string {
  const year = new Date().getFullYear()

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your ${APP_NAME} ${copy.noun}</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your one-time ${copy.noun} for ${APP_NAME} — expires in ${copy.minutes} minutes.
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
                    ${copy.label}
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:32px 40px 0 40px;">
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    ${copy.intro} for <strong>${APP_NAME}</strong>.
                    It expires in <strong>${copy.minutes} minutes</strong>.
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

              ${emailFooterHtml(`This is a transactional email sent because ${copy.because}.`)}

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `
}

function generateOtpEmailText(name: string, code: string, copy: OtpCopy = LOGIN_OTP_COPY): string {
  const year = new Date().getFullYear()

  return `
Hi ${name},

Your ${APP_NAME} ${copy.noun} is:

${code}

This code expires in ${copy.minutes} minutes.

NEVER share this code with anyone. ${APP_NAME} will never ask for your code by phone or email.

If you did not request this code, you can safely ignore this email.
For concerns, contact us at ${APP_SUPPORT_EMAIL}.

---
${emailFooterText(`This is a transactional email sent because ${copy.because}.`)}
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
                    Having trouble signing in? Contact your Administrator or reach us at
                    <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#4f46e5;text-decoration:none;">
                      ${APP_SUPPORT_EMAIL}
                    </a>.
                  </p>
                </td>
              </tr>

              ${emailFooterHtml(`This email was sent because an Administrator created an account for you. If this was a mistake, contact us immediately.`)}

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
${emailFooterText(`This email was sent because an Administrator created an account for you. If this was a mistake, contact us immediately.`)}
  `.trim()
}

export interface PasswordChangedEmailParams {
  to:        string
  firstName: string | null
  /** When the change landed, already formatted for the recipient to read. */
  changedAt: string
  /**
   * Roughly where the change came from ("San Pablo City, Philippines"), shown so
   * the reader can recognise it as theirs or not. See lib/ip-location.ts.
   *
   * The email carries a place, never the IP address itself. The place is passed
   * in, rendered, and dropped: it is never written to the audit log, the request
   * row or a console line. If you are about to persist it, or put the IP back,
   * that is a company privacy policy you are changing.
   */
  location?: string | null
  /**
   * True (the default) when this follows a completed reset, which signs out
   * every device and lifts any lockout. False for a change made while signed
   * in (first-login or otherwise), which does neither - so the email must not
   * claim it did.
   */
  afterReset?: boolean
}

/**
 * Tell someone their password was just changed.
 *
 * This is a security notification, not a courtesy: the person who most needs it
 * is the one who did NOT do it. If an account is taken over, the takeover ends
 * with a password change, and this mail is the only thing that reaches the real
 * owner afterwards -- every session was revoked, so nothing in the app can warn
 * them any more.
 *
 * That is why it goes out even though the reset itself already told the person
 * on screen, and why it is addressed to the account's CURRENT email rather than
 * the address the reset was requested from.
 *
 * Deliberately absent: the new password (it is never ours to repeat), a reset
 * link (this mail grants nothing, so a leaked copy is worthless), and the IP
 * address -- company policy is that a user's IP is never recorded. An
 * approximate location stands in for it, because "was this you?" cannot be
 * answered from a timestamp alone.
 */
export async function sendPasswordChangedEmail(
  params: PasswordChangedEmailParams,
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, changedAt, location = null, afterReset = true } = params
  const name    = firstName ?? 'there'
  const place   = location?.trim() || null
  const meaning = afterReset
    ? 'Any devices that were signed in to your account have been signed out, and any lock on your account has been lifted.'
    : 'Use your new password the next time you sign in. Your old password no longer works.'

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Your ${APP_NAME} password was changed`,
      htmlContent: generatePasswordChangedEmailHtml(name, changedAt, place, meaning),
      textContent: generatePasswordChangedEmailText(name, changedAt, place, meaning),
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO PASSWORD CHANGED EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    throw new Error(`Failed to send password changed email: ${error}`)
  }
}

function generatePasswordChangedEmailHtml(
  name:      string,
  changedAt: string,
  place:     string | null,
  meaning:   string,
): string {
  const year = new Date().getFullYear()

  // Only rendered when we actually have a place to show — see lib/ip-location.ts.
  const placeRow = place
    ? `
                        <p style="margin:8px 0 0 0;font-family:Arial,sans-serif;font-size:14px;color:#115e59;line-height:1.6;">
                          The change was made from near <strong>${escapeHtml(place)}</strong> (approximate location).
                        </p>`
    : ''

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your ${APP_NAME} password was changed</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your ${APP_NAME} password was changed on ${changedAt}. If this was not you, contact us immediately.
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
                    Password Changed
                  </p>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:36px 40px 8px 40px;">
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Your ${APP_NAME} password was changed on <strong>${changedAt}</strong>.
                    You can now sign in with your new password.
                  </p>
                </td>
              </tr>

              <!-- Confirmation panel -->
              <tr>
                <td style="padding:0 40px 28px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#f0fdfa;border-left:4px solid #0d9488;border-radius:4px;padding:16px 18px;">
                        <p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#115e59;line-height:1.6;font-weight:bold;">
                          What this means
                        </p>
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#115e59;line-height:1.6;">
                          ${meaning}
                        </p>${placeRow}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- The part that matters -->
              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:16px 18px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.6;">
                          <strong>If you did not do this,</strong> your account may be at risk.
                          Contact us straight away at
                          <a href="mailto:${APP_SUPPORT_EMAIL}" style="color:#92400e;text-decoration:underline;">${APP_SUPPORT_EMAIL}</a>
                          so we can secure it.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              ${emailFooterHtml(`This is a security notification sent because your password changed. It cannot be turned off.`)}

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `
}

function generatePasswordChangedEmailText(
  name:      string,
  changedAt: string,
  place:     string | null,
  meaning:   string,
): string {
  const year = new Date().getFullYear()
  const placeLine = place ? `\nThe change was made from near ${place} (approximate location).` : ''

  return `
Hi ${name},

Your ${APP_NAME} password was changed on ${changedAt}. You can now sign in with your new password.

WHAT THIS MEANS
${meaning}${placeLine}

IF YOU DID NOT DO THIS
Your account may be at risk. Contact us straight away at ${APP_SUPPORT_EMAIL} so we can secure it.

---
${emailFooterText(`This is a security notification sent because your password changed. It cannot be turned off.`)}
  `.trim()
}

// ---------------------------------------------------------------------------
// Company copy of every completed password reset or password change.
//
// The account holder already gets sendPasswordChangedEmail; this one goes to the
// company mailbox so someone other than the (possibly compromised) account holder
// sees every reset and password change across all roles.
//
// TESTING MAILBOX for now: 8338logisticsservice@gmail.com. Do NOT swap in the
// official 8338logisitcsservice@gmail.com (note the different spelling) until
// the company says to — set PASSWORD_RESET_ALERT_EMAIL to change it without a
// code edit.
// ---------------------------------------------------------------------------
const PASSWORD_RESET_ALERT_EMAIL =
  process.env.PASSWORD_RESET_ALERT_EMAIL?.trim() || '8338logisticsservice@gmail.com'

export interface PasswordResetAlertEmailParams {
  userEmail: string
  fullName:  string | null
  role:      string | null
  /** When the change landed, already formatted for reading. */
  changedAt: string
  /**
   * reset       - finished a reset (emailed link or IT Admin code)
   * first_login - replaced the temporary password they were issued
   * change      - changed it themselves while signed in
   */
  kind?:     'reset' | 'first_login' | 'change'
  /** Approximate place the change came from; never the IP. Row left out when null. */
  location?: string | null
}

const PASSWORD_ALERT_COPY = {
  reset:       { heading: 'Password Reset Completed',   sentence: 'successfully reset their',                        subject: 'password reset completed by' },
  first_login: { heading: 'First Sign-in Password Set', sentence: 'replaced their temporary password and set a new', subject: 'first sign-in password set by' },
  change:      { heading: 'Password Changed',           sentence: 'changed their',                                   subject: 'password changed by' },
} as const

/** "September 27, 2026 at 3:04 PM (PHT)" - the form every password email uses. */
export function formatManilaTimestamp(iso?: string | null): string {
  const when = iso ? new Date(iso) : new Date()
  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone:  'Asia/Manila',
  }).format(when) + ' (PHT)'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Deliberately carries no IP address, no password and no link: it is a record
 * that the password changed, not a way to act on the account.
 */
export async function sendPasswordResetAlertEmail(
  params: PasswordResetAlertEmailParams,
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { userEmail, fullName, role, changedAt, kind = 'reset', location = null } = params
  const copy      = PASSWORD_ALERT_COPY[kind]
  const name      = fullName ?? userEmail
  const roleLabel = role ? (ROLE_LABELS[role] ?? role.replace(/_/g, ' ')) : 'Unknown role'
  const year      = new Date().getFullYear()

  const rows: Array<[string, string]> = [
    ['Name',       name],
    ['Email',      userEmail],
    ['Role',       roleLabel],
    ['Changed on', changedAt],
    ...(location ? [['Location', `${location} (approximate)`] as [string, string]] : []),
  ]
  const rowsHtml = rows
    .map(([label, value]) => `
                  <tr>
                    <td style="padding:6px 16px 6px 0;font-family:Arial,sans-serif;font-size:14px;color:#818181;white-space:nowrap;">${label}</td>
                    <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:14px;color:#333333;">${escapeHtml(value)}</td>
                  </tr>`)
    .join('')

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>${copy.heading}</title></head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
              <tr>
                <td style="background-color:#0a0a0a;padding:32px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">${APP_NAME}</h1>
                  <p style="margin:6px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">${copy.heading}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 12px 40px;">
                  <p style="margin:0 0 20px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    A user ${copy.sentence} ${APP_NAME} password.
                  </p>
                  <table cellpadding="0" cellspacing="0" border="0">${rowsHtml}
                  </table>
                </td>
              </tr>
              ${emailFooterHtml(`Automatic notice sent whenever any user resets or changes their password.`)}
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `

  const textContent = `
A user ${copy.sentence} ${APP_NAME} password.

${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}

---
${emailFooterText(`Automatic notice sent whenever any user resets or changes their password.`)}
  `.trim()

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `${APP_NAME}: ${copy.subject} ${name}`,
      htmlContent,
      textContent,
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: PASSWORD_RESET_ALERT_EMAIL }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO PASSWORD RESET ALERT EMAIL ERROR:', {
      error,
      recipient: PASSWORD_RESET_ALERT_EMAIL,
      timestamp: new Date().toISOString(),
    })
    throw new Error(`Failed to send password reset alert email: ${error}`)
  }
}

// ---------------------------------------------------------------------------
// Landing-page contact form. Every enquiry goes to one company inbox.
//
// TESTING MAILBOX for now, the same one the password alerts use:
// 8338logisticsservice@gmail.com. Do NOT swap in the official
// 8338logisticsservices@gmail.com (note the extra "s") until the company says
// to — set CONTACT_INBOX_EMAIL to change it without a code edit.
// ---------------------------------------------------------------------------
const CONTACT_INBOX_EMAIL =
  process.env.CONTACT_INBOX_EMAIL?.trim() || '8338logisticsservice@gmail.com'

const CONTACT_ROLE_LABELS: Record<string, string> = {
  fmcg:    'FMCG',
  shipper: 'Shipper',
  other:   'Other',
}

export interface ContactInquiryEmailParams {
  firstName: string
  lastName:  string
  email:     string
  phone?:    string | null
  role:      string
  message:   string
}

/**
 * Sent with the enquirer as reply-to, so answering it from the inbox writes
 * straight back to them rather than to our own sender address.
 */
export async function sendContactInquiryEmail(params: ContactInquiryEmailParams): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { firstName, lastName, email, phone, role, message } = params
  const fullName  = `${firstName} ${lastName}`
  const roleLabel = CONTACT_ROLE_LABELS[role] ?? role
  const year      = new Date().getFullYear()

  const rows: Array<[string, string]> = [
    ['Name',     fullName],
    ['Email',    email],
    ['Phone',    phone || 'Not given'],
    ['Role',     roleLabel],
    ['Received', formatManilaTimestamp()],
  ]
  const rowsHtml = rows
    .map(([label, value]) => `
                  <tr>
                    <td style="padding:6px 16px 6px 0;font-family:Arial,sans-serif;font-size:14px;color:#818181;white-space:nowrap;">${label}</td>
                    <td style="padding:6px 0;font-family:Arial,sans-serif;font-size:14px;color:#333333;">${escapeHtml(value)}</td>
                  </tr>`)
    .join('')
  const messageHtml = escapeHtml(message).replace(/\r?\n/g, '<br>')

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>New Website Enquiry</title></head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
              <tr>
                <td style="background-color:#0a0a0a;padding:32px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">${APP_NAME}</h1>
                  <p style="margin:6px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">New Website Enquiry</p>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px 12px 40px;">
                  <p style="margin:0 0 20px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Someone sent a message through the contact form on the website. Reply to this email to answer them directly.
                  </p>
                  <table cellpadding="0" cellspacing="0" border="0">${rowsHtml}
                  </table>
                  <p style="margin:24px 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#818181;">Message</p>
                  <div style="padding:16px;background-color:#f6f6f6;border-radius:6px;font-family:Arial,sans-serif;font-size:14px;color:#333333;line-height:1.6;">${messageHtml}</div>
                </td>
              </tr>
              ${emailFooterHtml(`Sent from the contact form on the ${APP_NAME} website.`)}
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `

  const textContent = `
Someone sent a message through the contact form on the website. Reply to this email to answer them directly.

${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}

Message:
${message}

---
${emailFooterText(`Sent from the contact form on the ${APP_NAME} website.`)}
  `.trim()

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Website enquiry from ${fullName} (${roleLabel})`,
      htmlContent,
      textContent,
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: CONTACT_INBOX_EMAIL }],
      replyTo:     { email, name: fullName },
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO CONTACT INQUIRY EMAIL ERROR:', {
      error,
      recipient: CONTACT_INBOX_EMAIL,
      timestamp: new Date().toISOString(),
    })
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send contact inquiry email: ${error}`,
    })
    throw new Error(`Failed to send contact inquiry email: ${error}`)
  }
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
        Your Administrator sent you a link to set a new ${APP_NAME} password — it expires in ${minutes} minutes.
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
                    Your Administrator has approved your password reset request.
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
                          If you did not ask for a reset, contact your Administrator immediately.
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

              ${emailFooterHtml(`This is a transactional email sent because a password reset was approved for your account.`)}

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

Your Administrator has approved your password reset request.

Open this link to choose a new password:

${resetUrl}

This link works ONCE and expires in ${minutes} minutes. Setting a new password also
unlocks your account.

DO NOT FORWARD THIS EMAIL. Anyone with this link can set your password until it is
used or expires. If you did not ask for a reset, contact your Administrator immediately.

Link expired? Request another reset from the sign-in screen, or reach us at ${APP_SUPPORT_EMAIL}.

---
${emailFooterText(`This is a transactional email sent because a password reset was approved for your account.`)}
  `.trim()
}

// ---------------------------------------------------------------------------
// Passkey enrolment, for outside-vendor drivers.

/**
 * The setup link a vendor driver is sent when ops gives them app access.
 *
 * Points at the web app first and hands off to the mobile app from there, exactly
 * as the driver password-reset link does. That indirection is what makes the link
 * work from a desktop mailbox and from a phone that has not installed the app
 * yet — a bare app-scheme URL in an email is a dead end in both cases.
 *
 * Throws on a missing base URL for the same reason buildResetUrl does: this email
 * is nothing but the link, and a broken one strands a driver who has no other way
 * into the app at all.
 */
export function buildDriverSetupUrl(token: string): string {
  const base = appBaseUrl()
  if (!base) {
    throw new Error(
      'Cannot build a driver setup link: set FRONTEND_URL (or NEXT_PUBLIC_APP_URL) ' +
      'to the web app origin, e.g. https://your-app.example.com',
    )
  }
  return `${base}/driver-setup?token=${encodeURIComponent(token)}&app=1`
}

export interface DriverEnrollmentEmailParams {
  to:             string
  firstName:      string | null
  setupUrl:       string
  expiresInHours: number
  bookingRef?:    string | null
}

/**
 * The enrolment invite.
 *
 * Note what is NOT in here, and note that the copy says so: no password, ever.
 * This account has none. The link lets the driver create a passkey on their own
 * phone, and the private half never leaves that handset — so a forwarded copy is
 * useless to anyone not holding the phone, and the email says plainly that
 * forwarding it is not a thing anyone should be doing.
 */
export async function sendDriverEnrollmentEmail(
  params: DriverEnrollmentEmailParams,
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, setupUrl, expiresInHours, bookingRef } = params
  const name = firstName ?? 'there'

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Set up your ${APP_NAME} driver sign-in`,
      htmlContent: generateDriverEnrollmentEmailHtml(name, setupUrl, expiresInHours, bookingRef ?? null),
      textContent: generateDriverEnrollmentEmailText(name, setupUrl, expiresInHours, bookingRef ?? null),
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO DRIVER ENROLLMENT EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send driver enrollment email: ${error}`,
    })
    throw new Error(`Failed to send driver enrollment email: ${error}`)
  }
}

function generateDriverEnrollmentEmailHtml(
  name:       string,
  setupUrl:   string,
  hours:      number,
  bookingRef: string | null,
): string {
  const year = new Date().getFullYear()
  const forBooking = bookingRef
    ? `You have been assigned to booking <strong>${bookingRef}</strong>.`
    : `You have been registered as a driver on ${APP_NAME}.`

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Set up your ${APP_NAME} driver sign-in</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Set up sign-in for the ${APP_NAME} driver app &mdash; this link expires in ${hours} hours.
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
                    Driver App Setup
                  </p>
                </td>
              </tr>

              <!-- Body -->
              <tr>
                <td style="padding:32px 40px 0 40px;">
                  <p style="margin:0 0 12px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    ${forBooking} Set up sign-in on your phone to see your stops, get directions,
                    and record proof of delivery.
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    <strong>There is no password.</strong> You will unlock the app with your
                    fingerprint, face, or phone PIN. That unlock stays on your phone and is never
                    sent to us.
                  </p>
                </td>
              </tr>

              <!-- Call to action -->
              <tr>
                <td align="center" style="padding:0 40px 28px 40px;">
                  <a href="${setupUrl}"
                     style="display:inline-block;background-color:#0a0a0a;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:6px;">
                    Set up sign-in
                  </a>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 28px 40px;">
                  <p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.6;">
                    This link works once and expires in ${hours} hours. Open it on the phone you
                    will use for deliveries.
                  </p>
                  <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#666666;line-height:1.6;">
                    <strong>Do not forward this email.</strong> If you were not expecting it,
                    ignore it and tell your dispatcher.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 32px 40px;border-top:1px solid #eeeeee;">
                  <p style="margin:16px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#999999;line-height:1.6;">
                    Link expired or not working? Ask your dispatcher to send a new one, or reach us
                    at ${APP_SUPPORT_EMAIL}.
                  </p>
                </td>
              </tr>

              ${emailFooterHtml(`This is a transactional email sent because you were registered as a driver or assigned a delivery.`)}

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `.trim()
}

function generateDriverEnrollmentEmailText(
  name:       string,
  setupUrl:   string,
  hours:      number,
  bookingRef: string | null,
): string {
  const year = new Date().getFullYear()
  const forBooking = bookingRef
    ? `You have been assigned to booking ${bookingRef}.`
    : `You have been registered as a driver on ${APP_NAME}.`

  return `
Hi ${name},

${forBooking} Set up sign-in on your phone to see your stops, get directions, and
record proof of delivery.

THERE IS NO PASSWORD. You will unlock the app with your fingerprint, face, or phone
PIN. That unlock stays on your phone and is never sent to us.

Open this link on the phone you will use for deliveries:

${setupUrl}

This link works ONCE and expires in ${hours} hours.

DO NOT FORWARD THIS EMAIL. If you were not expecting it, ignore it and tell your
dispatcher.

Link expired or not working? Ask your dispatcher to send a new one, or reach us at
${APP_SUPPORT_EMAIL}.

---
${emailFooterText(`This is a transactional email sent because you were registered as a driver or assigned a delivery.`)}
  `.trim()
}
// ---------------------------------------------------------------------------
// Driver's licence expiry reminder, sent one month before the expiry date by
// services/notification/license-expiry.scheduler.ts. The in-app notification
// carries the same message; this copy reaches a driver who has not opened the
// app in a while.
// ---------------------------------------------------------------------------
export interface LicenseExpiryEmailParams {
  to:            string
  firstName:     string | null
  /** The expiry date, already formatted for reading ("November 4, 2026"). */
  expiresOn:     string
  /** Whole days from today to the expiry date. */
  daysLeft:      number
  licenseNumber: string | null
}

export async function sendLicenseExpiryEmail(params: LicenseExpiryEmailParams): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, expiresOn, daysLeft, licenseNumber } = params
  const name    = escapeHtml(firstName?.trim() || 'there')
  const inDays  = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'in 1 day' : `in ${daysLeft} days`
  const licenseNo = licenseNumber?.trim() ? ` (license number ${escapeHtml(licenseNumber.trim())})` : ''
  const reason  = `This reminder was sent because the driver's license on your ${APP_NAME} driver account is about to expire.`

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your driver's license expires soon</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Your driver's license expires on ${expiresOn}. Renew it before then.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <tr>
                <td style="background-color:#0a0a0a;padding:32px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">
                    ${APP_NAME}
                  </h1>
                  <p style="margin:6px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">
                    License Expiry Reminder
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:36px 40px 8px 40px;">
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Your driver's license${licenseNo} expires on <strong>${expiresOn}</strong>, ${inDays}.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:16px 18px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.6;">
                          <strong>Renew it before it expires.</strong> Once you have the renewed license,
                          give the new expiry date and a photo of the card to the Company Administrator
                          so your account stays up to date.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              ${emailFooterHtml(reason)}

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `.trim()

  const textContent = `
Hi ${firstName?.trim() || 'there'},

Your driver's license${licenseNumber?.trim() ? ` (license number ${licenseNumber.trim()})` : ''} expires on ${expiresOn}, ${inDays}.

RENEW IT BEFORE IT EXPIRES
Once you have the renewed license, give the new expiry date and a photo of the
card to the Company Administrator so your account stays up to date.

---
${emailFooterText(reason)}
  `.trim()

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Your driver's license expires on ${expiresOn}`,
      htmlContent,
      textContent,
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO LICENSE EXPIRY EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send license expiry email: ${error}`,
    })
    throw new Error(`Failed to send license expiry email: ${error}`)
  }
}

// ---------------------------------------------------------------------------
// Delivery finished, please confirm. Sent to the client when the driver
// completes the last drop-off (booking -> 'delivered'), alongside the in-app
// `delivery_confirm` notification. The booking completes on its own after the
// auto-complete window unless the client reports a problem first.
// ---------------------------------------------------------------------------
export interface DeliveryConfirmEmailParams {
  to:             string
  firstName:      string | null
  /** Reference number, or whatever the notifications use when there is none. */
  bookingLabel:   string
  /** When it completes on its own, already formatted for reading. */
  autoCompleteOn: string
  bookingId:      string
}

export async function sendDeliveryConfirmEmail(params: DeliveryConfirmEmailParams): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('Brevo is not configured. Please set BREVO_API_KEY.')
  }
  if (!process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Brevo sender is not configured. Please set BREVO_SENDER_EMAIL.')
  }

  const { to, firstName, bookingLabel, autoCompleteOn, bookingId } = params
  const name   = escapeHtml(firstName?.trim() || 'there')
  const label  = escapeHtml(bookingLabel)
  // The client's booking page opens this booking with the Confirm / Report a
  // problem panel. Without an app URL the email still says what to do, just
  // without a button.
  const base   = appBaseUrl()
  const url    = base ? `${base}/client/history?booking=${encodeURIComponent(bookingId)}` : null
  const reason = `This email was sent because a delivery on your ${APP_NAME} booking was finished and needs your confirmation.`

  const buttonHtml = url
    ? `
              <tr>
                <td style="padding:0 40px 28px 40px;" align="center">
                  <a href="${url}"
                    style="display:inline-block;background-color:#0a0a0a;color:#ffffff;
                      font-family:Arial,sans-serif;font-size:14px;font-weight:700;
                      text-decoration:none;padding:14px 36px;border-radius:8px;
                      letter-spacing:0.08em;">
                    Review Delivery
                  </a>
                </td>
              </tr>`
    : ''

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Delivery finished, please confirm</title>
    </head>
    <body style="margin:0;padding:0;background-color:#f6f6f6;">

      <div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
        Booking ${label} was delivered. Confirm it, or report a problem before ${autoCompleteOn}.
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0"
              style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">

              <tr>
                <td style="background-color:#0a0a0a;padding:32px 40px;">
                  <h1 style="margin:0;font-family:Arial,sans-serif;font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">
                    ${APP_NAME}
                  </h1>
                  <p style="margin:6px 0 0 0;font-family:Arial,sans-serif;font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">
                    Delivery Finished
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:36px 40px 8px 40px;">
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    The driver has finished every drop-off for booking <strong>${label}</strong>.
                  </p>
                  <p style="margin:0 0 24px 0;font-family:Arial,sans-serif;font-size:16px;color:#333333;line-height:1.6;">
                    Please check that everything was received, then confirm the booking is complete,
                    or report a problem if something is wrong.
                  </p>
                </td>
              </tr>

              ${buttonHtml}

              <tr>
                <td style="padding:0 40px 30px 40px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#fff8f0;border-left:4px solid #f59e0b;border-radius:4px;padding:16px 18px;">
                        <p style="margin:0;font-family:Arial,sans-serif;font-size:14px;color:#92400e;line-height:1.6;">
                          <strong>No reply needed if all is well.</strong> If nothing is reported, this booking
                          is marked as received automatically on <strong>${autoCompleteOn}</strong>.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              ${emailFooterHtml(reason)}

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `.trim()

  const textContent = `
Hi ${firstName?.trim() || 'there'},

The driver has finished every drop-off for booking ${bookingLabel}.

Please check that everything was received, then confirm the booking is complete,
or report a problem if something is wrong.${url ? `\n\nReview the delivery: ${url}` : ''}

NO REPLY NEEDED IF ALL IS WELL
If nothing is reported, this booking is marked as received automatically on ${autoCompleteOn}.

---
${emailFooterText(reason)}
  `.trim()

  try {
    const brevo = getBrevoClient()
    await brevo.transactionalEmails.sendTransacEmail({
      subject:     `Booking ${bookingLabel} delivered — please confirm`,
      htmlContent,
      textContent,
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: firstName ?? undefined }],
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('BREVO DELIVERY CONFIRM EMAIL ERROR:', {
      error,
      recipient: to,
      timestamp: new Date().toISOString(),
    })
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     'brevo-mailer',
      message:    `Failed to send delivery confirmation email: ${error}`,
    })
    throw new Error(`Failed to send delivery confirmation email: ${error}`)
  }
}
