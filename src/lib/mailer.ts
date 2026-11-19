import axios from 'axios'
import crypto from 'crypto'
import { logSystem } from './log-system.js'

/**
 * Every email the system sends, through Resend (2026-11-18; Brevo before).
 *
 * Why Resend: Brevo rewrites every link through its click tracker, with no way
 * to turn that off for one email, and the tracker made the password-reset
 * button slow or dead while the same address pasted by hand worked. Industry
 * practice (Postmark, SendGrid, Auth0) is never to click-track a password or
 * sign-in link. Resend's click tracking is a per-domain setting, OFF by default:
 * keep it off for 8338logistics.delivery.
 *
 * One design for all of them: layoutHtml() is the only page shell, and the
 * blocks below it (greeting, paragraph, button, notice, code box, detail rows,
 * quoted text) are the only pieces an email is built from. A new email uses
 * them; it never writes its own <html>.
 *
 * Env: RESEND_API_KEY, MAIL_FROM_EMAIL (no-reply@8338logistics.delivery).
 * Brevo was removed entirely on 2026-11-18: without RESEND_API_KEY nothing is
 * emailed, and every attempt is logged as a mailer error.
 */

const APP_NAME          = process.env.APP_NAME             || 'Logistics'
const PHYSICAL_ADDRESS  = process.env.APP_PHYSICAL_ADDRESS || 'Blk. 6 Lot 8 Lynville Enclave, Mamatid, City of Cabuyao, Laguna'
const FROM_EMAIL        = process.env.MAIL_FROM_EMAIL || ''
const FROM_NAME         = process.env.APP_NAME             || 'Logistics'
const APP_SUPPORT_EMAIL = process.env.APP_SUPPORT_EMAIL    || FROM_EMAIL

/** System Logs source for a send that failed (the IT dashboard's Email card). */
export const MAILER_LOG_SOURCE = 'mailer'

// ── Links ──────────────────────────────────────────────────────────────────

/**
 * Where the web app lives, for links we put in emails. FRONTEND_URL first (the
 * variable this backend actually sets). Null rather than a placeholder so each
 * caller decides what a missing base means: a host-less link is a dead link.
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

/** Say at boot where emailed links point and which provider sends. */
export function reportEmailLinkBaseUrl(): void {
  if (process.env.RESEND_API_KEY) console.log('Email provider: Resend')
  else console.warn('[email] RESEND_API_KEY is not set. Nothing can be emailed (sign-in codes, resets, reminders).')
  if (!FROM_EMAIL) console.warn('[email] MAIL_FROM_EMAIL is not set. Nothing can be emailed.')

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

/**
 * The absolute reset link for a token: always the https web page (an email
 * client can't be relied on to open a custom scheme). A driver's carries
 * `&app=1`, a routing hint that hands off to the mobile app; it grants nothing.
 * Throws with no app URL: a reset email is only its link.
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

/** The vendor driver's setup link: web page first, hands off to the app. Throws with no app URL. */
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

// ── Small helpers ──────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  admin:              'Company Administrator',
  it_admin:           'IT Administrator',
  general_manager:    'General Manager',
  fleet_manager:      'Fleet Manager',
  operations_manager: 'Operations Manager',
  driver:             'Driver',
  client:             'Client',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
const esc = escapeHtml

/** "September 27, 2026 at 3:04 PM (PHT)" - the form every password email uses. */
export function formatManilaTimestamp(iso?: string | null): string {
  const when = iso ? new Date(iso) : new Date()
  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone:  'Asia/Manila',
  }).format(when) + ' (PHT)'
}

const UPPER  = 'ABCDEFGHJKLMNPQRSTUVWXYZ'  // no I, O
const LOWER  = 'abcdefghjkmnpqrstuvwxyz'    // no i, l, o
const DIGITS = '23456789'                   // no 0, 1

/** How long a generated password works; mirrors the set_temp_password_expiry DB trigger. */
export const TEMP_PASSWORD_TTL_DAYS = 7

/**
 * The temporary password in the welcome email: 8 characters, at least one
 * capital, one small letter and one digit, no look-alikes (I/l/1, O/0).
 */
export function generateSecurePassword(): string {
  const pick = (charset: string, count: number): string[] =>
    Array.from({ length: count }, () => charset[crypto.randomInt(charset.length)])
  const chars = [
    ...pick(UPPER,  2),
    ...pick(LOWER,  3),
    ...pick(DIGITS, 2),
    ...pick(UPPER + LOWER + DIGITS, 1),
  ]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

// ── The one design ─────────────────────────────────────────────────────────

const FONT  = 'font-family:Arial,Helvetica,sans-serif;'
const MONO  = "font-family:'Courier New',Courier,monospace;"
const LINK  = 'color:#4f46e5;text-decoration:none;'

interface EmailLayout {
  /** Browser-tab title, and the small caption under the app name in the black band. */
  label:      string
  /** The grey line after the subject in the inbox. Never a code or password. */
  preheader?: string
  /** Blocks from the helpers below, in order. */
  blocks:     string[]
  /** "Why you got this", the footer's last line. */
  footer:     string
}

/**
 * The page every email uses: grey page, white 600px card, black band with the
 * app name and the email's label, the blocks, the grey footer.
 */
function layoutHtml({ label, preheader, blocks, footer }: EmailLayout): string {
  const year = new Date().getFullYear()
  const foot = `${FONT}font-size:12px;color:#999999;text-align:center;line-height:1.5;`
  // Padded with invisible characters so mail apps don't fill the rest of the
  // preview with the email's opening lines (user 2026-11-14).
  const pre = preheader
    ? `<div style="display:none;font-size:1px;color:#f6f6f6;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(120)}</div>`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(label)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f6f6f6;">
  ${pre}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;padding:40px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
          style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
          <tr>
            <td style="background-color:#0a0a0a;padding:32px 40px;">
              <h1 style="margin:0;${FONT}font-size:22px;color:#ffffff;font-weight:700;letter-spacing:0.05em;">${esc(APP_NAME)}</h1>
              <p style="margin:6px 0 0 0;${FONT}font-size:12px;color:#818181;letter-spacing:0.12em;text-transform:uppercase;">${esc(label)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px 8px 40px;">
              ${blocks.filter(Boolean).join('\n              ')}
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9f9f9;padding:20px 40px;border-top:1px solid #eeeeee;">
              <p style="margin:0 0 6px 0;${foot}">&copy; ${year} ${esc(APP_NAME)}. All rights reserved.</p>
              <p style="margin:0 0 6px 0;${foot}">${esc(PHYSICAL_ADDRESS)}</p>
              <p style="margin:0;${foot}">${esc(footer)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** The plain-text copy every email sends alongside: body, then the same footer. */
function layoutText(body: string, footer: string): string {
  const year = new Date().getFullYear()
  return `${body.trim()}\n\n---\n© ${year} ${APP_NAME}. All rights reserved.\n${PHYSICAL_ADDRESS}\n${footer}`
}

// Blocks. Each takes HTML-safe input where it says Html, plain text otherwise.

function greeting(name: string): string {
  return `<p style="margin:0 0 16px 0;${FONT}font-size:16px;color:#333333;line-height:1.6;">Hi ${esc(name)},</p>`
}

function para(html: string, opts: { muted?: boolean } = {}): string {
  const color = opts.muted ? '#555555' : '#333333'
  const size  = opts.muted ? 15 : 16
  return `<p style="margin:0 0 20px 0;${FONT}font-size:${size}px;color:${color};line-height:1.6;">${html}</p>`
}

/** Small grey help line (support address, "link expired?"). */
function help(html: string): string {
  return `<p style="margin:0 0 24px 0;${FONT}font-size:14px;color:#666666;line-height:1.6;">${html}</p>`
}

function button(url: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px 0;">
                <tr><td align="center">
                  <a href="${esc(url)}" style="display:inline-block;background-color:#0a0a0a;color:#ffffff;${FONT}font-size:14px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:0.08em;">${esc(label)}</a>
                </td></tr>
              </table>`
}

/** The address under a button, for a mail app that shows no button. */
function linkFallback(url: string): string {
  return `<p style="margin:0 0 6px 0;${FONT}font-size:13px;color:#777777;line-height:1.6;">If the button does not work, open this link:</p>
              <p style="margin:0 0 24px 0;${MONO}font-size:12px;word-break:break-all;"><a href="${esc(url)}" style="${LINK}">${esc(url)}</a></p>`
}

/** A coloured side-bar box: warn (amber) for what to watch out for, ok (teal) for what happened. */
function notice(html: string, tone: 'warn' | 'ok' = 'warn'): string {
  const [bg, bar, fg] = tone === 'warn' ? ['#fff8f0', '#f59e0b', '#92400e'] : ['#f0fdfa', '#0d9488', '#115e59']
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                <tr><td style="background-color:${bg};border-left:4px solid ${bar};border-radius:4px;padding:14px 16px;">
                  <p style="margin:0;${FONT}font-size:14px;color:${fg};line-height:1.6;">${html}</p>
                </td></tr>
              </table>`
}

/** The big one-time code. */
function codeBox(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                <tr><td align="center">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td style="background-color:#f4f4f5;border-radius:12px;padding:24px 48px;text-align:center;">
                      <span style="${MONO}font-size:40px;font-weight:bold;letter-spacing:12px;color:#1a1a1a;">${esc(code)}</span>
                    </td>
                  </tr></table>
                </td></tr>
              </table>`
}

/** Label / value pairs in a light card (credentials, ticket details, reminders). */
function detailRows(rows: Array<[string, string]>, opts: { big?: string } = {}): string {
  const body = rows.map(([label, value], i) => {
    const big = label === opts.big
    const last = i === rows.length - 1
    return `<p style="margin:0 0 4px 0;${FONT}font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#999999;">${esc(label)}</p>
                    <p style="margin:0 0 ${last ? 0 : 16}px 0;${big ? `${MONO}font-size:22px;font-weight:bold;letter-spacing:4px;` : `${FONT}font-size:15px;`}color:#1a1a1a;word-break:break-word;">${esc(value)}</p>`
  }).join('\n                    ')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;background-color:#f8f8f8;border-radius:10px;border:1px solid #e8e8e8;">
                <tr><td style="padding:20px 24px;">
                    ${body}
                </td></tr>
              </table>`
}

/** A quoted piece of someone's own text (a message, a transcript, a staff note). */
function quoted(label: string, text: string): string {
  return `<p style="margin:0 0 8px 0;${FONT}font-size:14px;color:#818181;">${esc(label)}</p>
              <div style="margin:0 0 24px 0;padding:16px;background-color:#f6f6f6;border-radius:6px;${FONT}font-size:14px;color:#333333;line-height:1.6;">${esc(text).replace(/\r?\n/g, '<br>')}</div>`
}

const supportLink = () => `<a href="mailto:${esc(APP_SUPPORT_EMAIL)}" style="${LINK}">${esc(APP_SUPPORT_EMAIL)}</a>`
const rowsText = (rows: Array<[string, string]>) => rows.map(([l, v]) => `${l}: ${v}`).join('\n')

// ── Sending ────────────────────────────────────────────────────────────────

interface Address { email: string; name?: string | null }

interface OutgoingEmail {
  subject:  string
  html:     string
  text:     string
  to:       Address
  cc?:      Address
  replyTo?: Address | Address[]
  /** For the error message and log: "welcome email". */
  what:     string
  /**
   * The account this email is about when it goes to someone else (a client's
   * contract to the office, a driver's licence to the inbox). A seed account
   * here suppresses it like a seed recipient does.
   */
  about?:   string | null
  /**
   * A person just asked for it (sign-in code, password reset): sent even to a
   * seed account, so seed accounts stay testable. One per click, so no burst.
   */
  personAsked?: boolean
}

/**
 * Seed test accounts (scripts/seed-scenarios.mjs) use plus-addresses of the
 * testing inbox: 8338logisticsservice+seed.<kind><nnn>@gmail.com.
 */
export function isSeedEmail(email?: string | null): boolean {
  if (!email) return false
  return /\+seed\./i.test(email.split('@')[0] ?? '')
}

// Suppressed seed emails since boot, summarised on the console now and then
// (never System Logs: the schedulers would flood it).
let seedSuppressed = 0

const fmt = (a: Address) => (a.name ? `${a.name.replace(/[<>"]/g, '')} <${a.email}>` : a.email)

async function viaResend(m: OutgoingEmail): Promise<void> {
  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from:    fmt({ email: FROM_EMAIL, name: FROM_NAME }),
        to:      [fmt(m.to)],
        subject: m.subject,
        html:    m.html,
        text:    m.text,
        ...(m.cc ? { cc: [fmt(m.cc)] } : {}),
        ...(m.replyTo ? { reply_to: (Array.isArray(m.replyTo) ? m.replyTo : [m.replyTo]).map(fmt) } : {}),
      },
      {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
      },
    )
  } catch (err: any) {
    // Resend answers { name, message, statusCode }; never log the key.
    const data = err?.response?.data
    throw new Error(data?.message ? `Resend ${err.response.status}: ${data.message}` : (err?.message ?? String(err)))
  }
}

/** The only way an email leaves the system. Throws (and logs) when it can't be handed over. */
async function deliver(m: OutgoingEmail): Promise<void> {
  // Seed data never spends the email quota (user 2026-11-18: the seeded
  // schedulers' reminders went past Resend's daily limit). The email counts as
  // handed over, so callers stamp it and don't retry it every day; the in-app
  // notice and push still go out as usual.
  if (!m.personAsked && (isSeedEmail(m.to.email) || isSeedEmail(m.about))) {
    seedSuppressed++
    if (seedSuppressed === 1 || seedSuppressed % 50 === 0) {
      console.info(`[email] seed data: ${seedSuppressed} email(s) not sent since start (latest: ${m.what})`)
    }
    return
  }
  try {
    if (!FROM_EMAIL) throw new Error('No sender address. Set MAIL_FROM_EMAIL.')
    if (!process.env.RESEND_API_KEY) throw new Error('No email provider configured. Set RESEND_API_KEY.')
    await viaResend(m)
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('EMAIL SEND ERROR:', { what: m.what, error, timestamp: new Date().toISOString() })
    logSystem({
      log_level:  'error',
      event_type: 'email_event',
      source:     MAILER_LOG_SOURCE,
      message:    `Failed to send ${m.what}: ${error}`,
    })
    throw new Error(`Failed to send ${m.what}: ${error}`)
  }
}

// ── One-time codes (sign-in, IT Admin password reset) ──────────────────────

interface OtpCopy {
  label:   string   // the band caption
  noun:    string   // 'login code' / 'password reset code'
  intro:   string   // the sentence above the digits
  because: string   // why it was sent, for the footer
  minutes: number
}

const LOGIN_OTP_COPY: OtpCopy = {
  label:   'Sign-in Code',
  noun:    'login code',
  intro:   'Here is your one-time login code',
  because: 'a login was requested for your account',
  minutes: 5,
}

function otpEmail(name: string, code: string, copy: OtpCopy): { html: string; text: string } {
  const footer = `This is a transactional email sent because ${copy.because}.`
  const html = layoutHtml({
    label:     copy.label,
    preheader: `Your one-time ${copy.noun} for ${APP_NAME} is inside. It expires in ${copy.minutes} minutes.`,
    blocks: [
      greeting(name),
      para(`${esc(copy.intro)} for <strong>${esc(APP_NAME)}</strong>. It expires in <strong>${copy.minutes} minutes</strong>.`),
      codeBox(code),
      notice(`<strong>Never share this code.</strong> ${esc(APP_NAME)} will never ask for your code by phone or email.`),
      help(`If you did not request this code, you can safely ignore this email. Contact us at ${supportLink()} if you have concerns.`),
    ],
    footer,
  })
  // The code comes after the notes: some mail apps build the preview from the
  // plain-text copy, and its first ~200 characters must not hold it.
  const text = layoutText(`
Hi ${name},

${copy.intro} for ${APP_NAME}. It expires in ${copy.minutes} minutes.

NEVER share this code with anyone. ${APP_NAME} will never ask for your code by phone or email.

If you did not request this code, you can safely ignore this email.
For concerns, contact us at ${APP_SUPPORT_EMAIL}.

Your ${copy.noun}:

${code}`, footer)
  return { html, text }
}

export async function sendOtpEmail(to: string, code: string, firstName?: string | null): Promise<void> {
  // The code is never in the subject: it would show in the inbox list and on a
  // lock-screen notification without the email being opened.
  await deliver({
    personAsked: true,
    subject: `Your ${APP_NAME} sign-in code`,
    ...otpEmail(firstName ?? 'there', code, LOGIN_OTP_COPY),
    to:      { email: to, name: firstName },
    what:    'OTP email',
  })
}

export interface PasswordResetOtpEmailParams {
  to:               string
  firstName:        string | null
  code:             string
  expiresInMinutes: number
}

/** The reset code an IT Admin sends themselves. No link, no password. */
export async function sendPasswordResetOtpEmail(params: PasswordResetOtpEmailParams): Promise<void> {
  const { to, firstName, code, expiresInMinutes } = params
  await deliver({
    personAsked: true,
    subject: `Your ${APP_NAME} password reset code`,
    ...otpEmail(firstName ?? 'there', code, {
      label:   'Password Reset Code',
      noun:    'password reset code',
      intro:   'Here is your one-time password reset code',
      because: 'a password reset was requested for your Administrator account',
      minutes: expiresInMinutes,
    }),
    to:   { email: to, name: firstName },
    what: 'password reset code email',
  })
}

// ── Welcome (temporary password) ───────────────────────────────────────────

export interface WelcomeEmailParams {
  to:        string
  firstName: string | null
  role:      string
  password:  string
}

export async function sendWelcomeEmail(params: WelcomeEmailParams): Promise<void> {
  const { to, firstName, role, password } = params
  const name      = firstName ?? 'there'
  const roleLabel = ROLE_LABELS[role] ?? role.replace(/_/g, ' ')
  // The credentials are still useful without a working button, so no app URL
  // means no button rather than no email.
  const base      = appBaseUrl()
  const loginUrl  = base ? `${base}/` : null
  const footer    = 'This email was sent because an Administrator created an account for you. If this was a mistake, contact us immediately.'

  const html = layoutHtml({
    label:     'Account Credentials',
    preheader: `Your ${APP_NAME} account has been created. Open this email for your sign-in details.`,
    blocks: [
      greeting(name),
      para(`An account has been created for you on <strong>${esc(APP_NAME)}</strong> as a <strong>${esc(roleLabel)}</strong>.`),
      para('Use the details below to sign in. You can sign in with either your password or a one-time email code — both options are available on the sign-in screen.', { muted: true }),
      detailRows([['Email address', to], ['Temporary password', password]], { big: 'Temporary password' }),
      notice(`<strong>This is a temporary password. It expires in ${TEMP_PASSWORD_TTL_DAYS} days.</strong> Please change it after your first sign-in. Never share your password with anyone — ${esc(APP_NAME)} staff will never ask for it.`),
      loginUrl ? button(loginUrl, 'Sign In Now') : '',
      help(`Having trouble signing in? Contact your Administrator or reach us at ${supportLink()}.`),
    ],
    footer,
  })

  // The password comes after the notes (see otpEmail).
  const text = layoutText(`
Hi ${name},

An account has been created for you on ${APP_NAME} as a ${roleLabel}.

IMPORTANT: The password below is temporary and expires in ${TEMP_PASSWORD_TTL_DAYS} days.
Please change it after your first sign-in.
Never share your password with anyone — ${APP_NAME} staff will never ask for it.

You can also sign in using a one-time email code instead of a password — both options
are available on the sign-in screen.

── YOUR SIGN-IN DETAILS ────────────────────
Email:    ${to}
Password: ${password}
────────────────────────────────────────────
${loginUrl ? `\nSign in at: ${loginUrl}\n` : ''}
Need help? Contact us at ${APP_SUPPORT_EMAIL}.`, footer)

  await deliver({
    subject: `Welcome to ${APP_NAME} — Your account is ready`,
    html, text,
    to:   { email: to, name: firstName },
    what: 'welcome email',
  })
}

// ── Password reset link ────────────────────────────────────────────────────

export interface PasswordResetEmailParams {
  to:               string
  firstName:        string | null
  resetUrl:         string
  expiresInMinutes: number
}

/** The one-time reset link an administrator sends. No password in it. */
export async function sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<void> {
  const { to, firstName, resetUrl, expiresInMinutes: minutes } = params
  const name   = firstName ?? 'there'
  const footer = 'This is a transactional email sent because a password reset was approved for your account.'

  const html = layoutHtml({
    label:     'Password Reset',
    preheader: `Your Administrator sent you a link to set a new ${APP_NAME} password. It expires in ${minutes} minutes.`,
    blocks: [
      greeting(name),
      para('Your Administrator has approved your password reset request.'),
      para(`Use the button below to choose a new password. This link works <strong>once</strong> and expires in <strong>${minutes} minutes</strong>. Setting a new password also unlocks your account.`, { muted: true }),
      button(resetUrl, 'Set A New Password'),
      linkFallback(resetUrl),
      notice('<strong>Do not forward this email.</strong> Anyone with this link can set your password until it is used or expires. If you did not ask for a reset, contact your Administrator immediately.'),
      help(`Link expired? Request another reset from the sign-in screen, or reach us at ${supportLink()}.`),
    ],
    footer,
  })

  const text = layoutText(`
Hi ${name},

Your Administrator has approved your password reset request.

Open this link to choose a new password:

${resetUrl}

This link works ONCE and expires in ${minutes} minutes. Setting a new password also
unlocks your account.

DO NOT FORWARD THIS EMAIL. Anyone with this link can set your password until it is
used or expires. If you did not ask for a reset, contact your Administrator immediately.

Link expired? Request another reset from the sign-in screen, or reach us at ${APP_SUPPORT_EMAIL}.`, footer)

  await deliver({
    personAsked: true,
    subject: `Reset your ${APP_NAME} password`,
    html, text,
    to:   { email: to, name: firstName },
    what: 'password reset email',
  })
}

// ── Password changed (to the account holder) ───────────────────────────────

export interface PasswordChangedEmailParams {
  to:        string
  firstName: string | null
  /** When the change landed, already formatted for the recipient to read. */
  changedAt: string
  /**
   * Roughly where the change came from ("San Pablo City, Philippines"). A place,
   * never the IP; rendered and dropped, never stored (lib/ip-location.ts).
   */
  location?: string | null
  /** True (default) after a completed reset (signs out everywhere, lifts locks); false for a signed-in change. */
  afterReset?: boolean
}

/**
 * A security notice: the person who most needs it is the one who did NOT do
 * it. Carries no password, no link and no IP address.
 */
export async function sendPasswordChangedEmail(params: PasswordChangedEmailParams): Promise<void> {
  const { to, firstName, changedAt, location = null, afterReset = true } = params
  const name    = firstName ?? 'there'
  const place   = location?.trim() || null
  const meaning = afterReset
    ? 'Any devices that were signed in to your account have been signed out, and any lock on your account has been lifted.'
    : 'Use your new password the next time you sign in. Your old password no longer works.'
  const footer  = 'This is a security notification sent because your password changed. It cannot be turned off.'

  const html = layoutHtml({
    label:     'Password Changed',
    preheader: `Your ${APP_NAME} password was changed on ${changedAt}. If this was not you, contact us immediately.`,
    blocks: [
      greeting(name),
      para(`Your ${esc(APP_NAME)} password was changed on <strong>${esc(changedAt)}</strong>. You can now sign in with your new password.`),
      notice(`<strong>What this means.</strong> ${esc(meaning)}${place ? `<br>The change was made from near <strong>${esc(place)}</strong> (approximate location).` : ''}`, 'ok'),
      notice(`<strong>If you did not do this,</strong> your account may be at risk. Contact us straight away at <a href="mailto:${esc(APP_SUPPORT_EMAIL)}" style="color:#92400e;text-decoration:underline;">${esc(APP_SUPPORT_EMAIL)}</a> so we can secure it.`),
    ],
    footer,
  })

  const text = layoutText(`
Hi ${name},

Your ${APP_NAME} password was changed on ${changedAt}. You can now sign in with your new password.

WHAT THIS MEANS
${meaning}${place ? `\nThe change was made from near ${place} (approximate location).` : ''}

IF YOU DID NOT DO THIS
Your account may be at risk. Contact us straight away at ${APP_SUPPORT_EMAIL} so we can secure it.`, footer)

  await deliver({
    subject: `Your ${APP_NAME} password was changed`,
    html, text,
    to:   { email: to, name: firstName },
    what: 'password changed email',
  })
}

// ── Company copy of every password reset / change ──────────────────────────
//
// Goes to the company mailbox so someone other than the (possibly compromised)
// account holder sees it. TESTING MAILBOX for now: 8338logisticsservice@gmail.com.
// Do NOT swap in the official 8338logisitcsservice@gmail.com (different
// spelling) until the company says to; set PASSWORD_RESET_ALERT_EMAIL instead.

const PASSWORD_RESET_ALERT_EMAIL =
  process.env.PASSWORD_RESET_ALERT_EMAIL?.trim() || '8338logisticsservice@gmail.com'

export interface PasswordResetAlertEmailParams {
  userEmail: string
  fullName:  string | null
  role:      string | null
  /** When the change landed, already formatted for reading. */
  changedAt: string
  /** reset: finished a reset · first_login: replaced the temporary password · change: changed it while signed in */
  kind?:     'reset' | 'first_login' | 'change'
  /** Approximate place the change came from; never the IP. Row left out when null. */
  location?: string | null
}

const PASSWORD_ALERT_COPY = {
  reset:       { heading: 'Password Reset Completed',   sentence: 'successfully reset their',                        subject: 'password reset completed by' },
  first_login: { heading: 'First Sign-in Password Set', sentence: 'replaced their temporary password and set a new', subject: 'first sign-in password set by' },
  change:      { heading: 'Password Changed',           sentence: 'changed their',                                   subject: 'password changed by' },
} as const

/** A record that a password changed: no IP, no password, no link. */
export async function sendPasswordResetAlertEmail(params: PasswordResetAlertEmailParams): Promise<void> {
  const { userEmail, fullName, role, changedAt, kind = 'reset', location = null } = params
  const copy      = PASSWORD_ALERT_COPY[kind]
  const name      = fullName ?? userEmail
  const roleLabel = role ? (ROLE_LABELS[role] ?? role.replace(/_/g, ' ')) : 'Unknown role'
  const footer    = 'Automatic notice sent whenever any user resets or changes their password.'
  const rows: Array<[string, string]> = [
    ['Name',       name],
    ['Email',      userEmail],
    ['Role',       roleLabel],
    ['Changed on', changedAt],
    ...(location ? [['Location', `${location} (approximate)`] as [string, string]] : []),
  ]
  const intro = `A user ${copy.sentence} ${APP_NAME} password.`

  await deliver({
    about:   userEmail,
    subject: `${APP_NAME}: ${copy.subject} ${name}`,
    html:    layoutHtml({ label: copy.heading, blocks: [para(esc(intro)), detailRows(rows)], footer }),
    text:    layoutText(`${intro}\n\n${rowsText(rows)}`, footer),
    to:      { email: PASSWORD_RESET_ALERT_EMAIL },
    what:    'password reset alert email',
  })
}

// ── Landing-page contact form ──────────────────────────────────────────────
//
// Every enquiry goes to one company inbox. TESTING MAILBOX for now (same as the
// password alerts). Do NOT swap in the official 8338logisticsservices@gmail.com
// (extra "s") until the company says to; set CONTACT_INBOX_EMAIL instead.

const CONTACT_INBOX_EMAIL =
  process.env.CONTACT_INBOX_EMAIL?.trim() || '8338logisticsservice@gmail.com'

/** The inbox support tickets go to, so the dashboard can open it in Gmail. */
export function supportInboxEmail(): string {
  return CONTACT_INBOX_EMAIL
}

/**
 * Where replies to a ticket email go. TICKET_REPLY_EMAIL is an address Resend
 * receives for us (Receiving: a <id>.resend.app address, or one on a subdomain
 * with Resend's MX record); every reply there reaches POST
 * /api/webhooks/resend-inbound, is recorded on the ticket and passed on to the
 * inbox. Unset: replies go straight to the inbox as before (not tracked).
 */
export function ticketReplyEmail(): string {
  return process.env.TICKET_REPLY_EMAIL?.trim() || CONTACT_INBOX_EMAIL
}

/** Whether ticket replies are recorded (TICKET_REPLY_EMAIL is set). */
export function ticketRepliesTracked(): boolean {
  return Boolean(process.env.TICKET_REPLY_EMAIL?.trim())
}

export interface ContactInquiryEmailParams {
  firstName: string
  lastName:  string
  email:     string
  phone?:    string | null
  message:   string
}

/** Sent with the enquirer as reply-to, so answering it writes straight back to them. */
export async function sendContactInquiryEmail(params: ContactInquiryEmailParams): Promise<void> {
  const { firstName, lastName, email, phone, message } = params
  const fullName = `${firstName} ${lastName}`
  const footer   = `Sent from the contact form on the ${APP_NAME} website.`
  const intro    = 'Someone sent a message through the contact form on the website. Reply to this email to answer them directly.'
  const rows: Array<[string, string]> = [
    ['Name',     fullName],
    ['Email',    email],
    ['Phone',    phone || 'Not given'],
    ['Received', formatManilaTimestamp()],
  ]

  await deliver({
    subject: `Website enquiry from ${fullName}`,
    html:    layoutHtml({ label: 'New Website Enquiry', blocks: [para(esc(intro)), detailRows(rows), quoted('Message', message)], footer }),
    text:    layoutText(`${intro}\n\n${rowsText(rows)}\n\nMessage:\n${message}`, footer),
    to:      { email: CONTACT_INBOX_EMAIL },
    replyTo: { email, name: fullName },
    what:    'contact inquiry email',
  })
}

// ── Vendor driver setup link ───────────────────────────────────────────────

export interface DriverEnrollmentEmailParams {
  to:             string
  firstName:      string | null
  setupUrl:       string
  expiresInHours: number
  bookingRef?:    string | null
}

/** The optional passkey invite: the link sets up a passkey on the driver's phone. Password and emailed code still work (since 2026-11-09). */
export async function sendDriverEnrollmentEmail(params: DriverEnrollmentEmailParams): Promise<void> {
  const { to, firstName, setupUrl, expiresInHours: hours, bookingRef } = params
  const name   = firstName ?? 'there'
  const footer = 'This is a transactional email sent because you were registered as a driver or assigned a delivery.'
  const forBookingText = bookingRef
    ? `You have been assigned to booking ${bookingRef}.`
    : `You have been registered as a driver on ${APP_NAME}.`
  const forBookingHtml = bookingRef
    ? `You have been assigned to booking <strong>${esc(bookingRef)}</strong>.`
    : `You have been registered as a driver on ${esc(APP_NAME)}.`

  const html = layoutHtml({
    label:     'Driver App Setup',
    preheader: `Set up sign-in for the ${APP_NAME} driver app. This link expires in ${hours} hours.`,
    blocks: [
      greeting(name),
      para(`${forBookingHtml} Set up sign-in on your phone to see your stops, get directions, and record proof of delivery.`),
      para('This link sets up quick sign-in: you unlock the app with your fingerprint, face, or phone PIN. That unlock stays on your phone and is never sent to us. Your password and emailed sign-in code keep working too.'),
      button(setupUrl, 'Set Up Sign-in'),
      linkFallback(setupUrl),
      notice(`This link works once and expires in ${hours} hours. Open it on the phone you will use for deliveries. <strong>Do not forward this email.</strong> If you were not expecting it, ignore it and tell your dispatcher.`),
      help(`Link expired or not working? Ask your dispatcher to send a new one, or reach us at ${supportLink()}.`),
    ],
    footer,
  })

  const text = layoutText(`
Hi ${name},

${forBookingText} Set up sign-in on your phone to see your stops, get directions, and
record proof of delivery.

This link sets up quick sign-in: you unlock the app with your fingerprint, face, or
phone PIN. That unlock stays on your phone and is never sent to us. Your password and
emailed sign-in code keep working too.

Open this link on the phone you will use for deliveries:

${setupUrl}

This link works ONCE and expires in ${hours} hours.

DO NOT FORWARD THIS EMAIL. If you were not expecting it, ignore it and tell your
dispatcher.

Link expired or not working? Ask your dispatcher to send a new one, or reach us at
${APP_SUPPORT_EMAIL}.`, footer)

  await deliver({
    subject: `Set up your ${APP_NAME} driver sign-in`,
    html, text,
    to:   { email: to, name: firstName },
    what: 'driver enrollment email',
  })
}

// ── Driver's license expiry (to the driver) ────────────────────────────────

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
  const { to, firstName, expiresOn, daysLeft, licenseNumber } = params
  const name   = firstName?.trim() || 'there'
  const inDays = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'in 1 day' : `in ${daysLeft} days`
  const number = licenseNumber?.trim() || null
  const footer = `This reminder was sent because the driver's license on your ${APP_NAME} driver account is about to expire.`
  const renew  = 'Once you have the renewed license, give the new expiry date and a photo of the card to the Company Administrator so your account stays up to date.'

  const html = layoutHtml({
    label:     'License Expiry Reminder',
    preheader: `Your driver's license expires on ${expiresOn}. Renew it before then.`,
    blocks: [
      greeting(name),
      para(`Your driver's license${number ? ` (license number ${esc(number)})` : ''} expires on <strong>${esc(expiresOn)}</strong>, ${inDays}.`),
      notice(`<strong>Renew it before it expires.</strong> ${esc(renew)}`),
    ],
    footer,
  })

  const text = layoutText(`
Hi ${name},

Your driver's license${number ? ` (license number ${number})` : ''} expires on ${expiresOn}, ${inDays}.

RENEW IT BEFORE IT EXPIRES
${renew}`, footer)

  await deliver({
    subject: `Your driver's license expires on ${expiresOn}`,
    html, text,
    to:   { email: to, name: firstName },
    what: 'license expiry email',
  })
}

// ── Delivery finished, please confirm (to the client) ──────────────────────

export interface DeliveryConfirmEmailParams {
  to:             string
  firstName:      string | null
  /** Reference number, or whatever the notifications use when there is none. */
  bookingLabel:   string
  /** When it completes on its own, already formatted for reading. */
  autoCompleteOn: string
  /** The booking in the link: its number without "BK-" (lib/booking-ref bookingUrlKey), never the internal id. */
  bookingKey:     string
}

export async function sendDeliveryConfirmEmail(params: DeliveryConfirmEmailParams): Promise<void> {
  const { to, firstName, bookingLabel, autoCompleteOn, bookingKey } = params
  const name   = firstName?.trim() || 'there'
  // Opens the booking with the Confirm / Report a problem panel. No app URL:
  // the email still says what to do, without a button.
  const base   = appBaseUrl()
  const url    = base ? `${base}/client/history?booking=${encodeURIComponent(bookingKey)}` : null
  const footer = `This email was sent because a delivery on your ${APP_NAME} booking was finished and needs your confirmation.`
  const check  = 'Please check that everything was received, then confirm the booking is complete, or report a problem if something is wrong.'

  const html = layoutHtml({
    label:     'Delivery Finished',
    preheader: `Booking ${bookingLabel} was delivered. Confirm it, or report a problem before ${autoCompleteOn}.`,
    blocks: [
      greeting(name),
      para(`The driver has finished every drop-off for booking <strong>${esc(bookingLabel)}</strong>.`),
      para(esc(check)),
      url ? button(url, 'Review Delivery') : '',
      notice(`<strong>No reply needed if all is well.</strong> If nothing is reported, this booking is marked as received automatically on <strong>${esc(autoCompleteOn)}</strong>.`),
    ],
    footer,
  })

  const text = layoutText(`
Hi ${name},

The driver has finished every drop-off for booking ${bookingLabel}.

${check}${url ? `\n\nReview the delivery: ${url}` : ''}

NO REPLY NEEDED IF ALL IS WELL
If nothing is reported, this booking is marked as received automatically on ${autoCompleteOn}.`, footer)

  await deliver({
    subject: `Booking ${bookingLabel} delivered — please confirm`,
    html, text,
    to:   { email: to, name: firstName },
    what: 'delivery confirmation email',
  })
}

// ── Support tickets ────────────────────────────────────────────────────────
//
// ONE thread both sides share: the ticket email goes TO the client, CC the
// support inbox, replies to the support inbox. Staff "Reply all" lands in the
// client's thread; the client's "Reply" lands in the inbox's.

export interface SupportTicketEmailParams {
  reference:   string
  clientName:  string
  companyName: string | null
  email:       string
  category:    string
  subject:     string
  message:     string
  bookingRef:  string | null
  /** What the chatbot showed before the client asked for a person. */
  transcript:  Array<{ from: 'client' | 'bot'; text: string }>
  /** The staff member who opened it for the client; null when the client did. */
  openedBy?:   string | null
}

/** The ticket subject, shared by every email in the thread. */
export function supportTicketSubject(reference: string, subject: string): string {
  return `[${reference}] ${subject}`
}

export async function sendSupportTicketEmail(p: SupportTicketEmailParams): Promise<void> {
  const rows: Array<[string, string]> = [
    ['Ticket',   p.reference],
    ['Client',   p.clientName],
    ['Company',  p.companyName ?? 'Not given'],
    ['Email',    p.email],
    ['Topic',    p.category],
    ['Booking',  p.bookingRef ?? 'None'],
    ['Received', formatManilaTimestamp()],
  ]
  const transcript = p.transcript
    .map((m) => `${m.from === 'client' ? 'Client' : 'Assistant'}: ${m.text}`)
    .join('\n')
  // Opened by the office for the client (a call, an email, a walk-in).
  const intro = p.openedBy
    ? `Hi ${p.clientName}, our team opened support ticket ${p.reference} for you, from what you told us. ` +
      'We will reply in this email thread. To add details or correct anything, simply reply to this email.'
    : `Hi ${p.clientName}, we received your support ticket ${p.reference}. Our team will reply in this ` +
      'email thread. To add details, simply reply to this email.'
  const footer = p.openedBy
    ? `Our team opened this support ticket for you on the ${APP_NAME} website.`
    : `You opened a support ticket on the ${APP_NAME} website.`

  const html = layoutHtml({
    label:  'Support Ticket',
    blocks: [
      para(esc(intro)),
      detailRows(rows),
      quoted(`Subject: ${p.subject}`, p.message),
      transcript ? quoted('Your conversation with the help assistant', transcript) : '',
    ],
    footer,
  })
  const text = layoutText([
    intro, '', rowsText(rows), '', `Subject: ${p.subject}`, p.message,
    ...(transcript ? ['', 'Your conversation with the help assistant:', transcript] : []),
  ].join('\n'), footer)

  await deliver({
    about:   p.email,
    subject: supportTicketSubject(p.reference, p.subject),
    html, text,
    to:      { email: p.email, name: p.clientName },
    cc:      { email: CONTACT_INBOX_EMAIL },
    replyTo: { email: ticketReplyEmail() },
    what:    'support ticket email',
  })
}

/** Staff marked the ticket resolved. */
export async function sendSupportTicketResolvedEmail(p: {
  reference: string; clientName: string; email: string; subject: string; note: string | null
}): Promise<void> {
  const plain  = `Hi ${p.clientName}, your support ticket ${p.reference} (${p.subject}) has been marked resolved. If something is still wrong, reply to this email or open a new ticket from the help assistant.`
  const footer = `You opened a support ticket on the ${APP_NAME} website.`

  await deliver({
    // Same subject (Re:) and people as the ticket, so it stays in the thread.
    subject: `Re: ${supportTicketSubject(p.reference, p.subject)}`,
    html:    layoutHtml({ label: 'Support Ticket Resolved', blocks: [para(esc(plain)), p.note ? quoted('Note from our team', p.note) : ''], footer }),
    text:    layoutText([plain, ...(p.note ? ['', 'Note from our team:', p.note] : [])].join('\n'), footer),
    to:      { email: p.email, name: p.clientName },
    cc:      { email: CONTACT_INBOX_EMAIL },
    replyTo: { email: ticketReplyEmail() },
    what:    'support ticket resolved email',
  })
}

/**
 * A reply to a ticket reached the reply address but not the inbox (the client
 * pressed Reply, not Reply all): pass it on so staff see it in the same Gmail
 * thread. Reply all from Gmail answers the sender and keeps the reply address
 * in the loop, so the answer is recorded too.
 */
export async function sendTicketReplyForward(p: {
  subject: string; reference: string; fromEmail: string; fromName: string | null; body: string; note?: string | null
}): Promise<void> {
  const who    = p.fromName ? `${p.fromName} <${p.fromEmail}>` : p.fromEmail
  const intro  = `${who} replied to support ticket ${p.reference}.` + (p.note ? ` ${p.note}` : '')
  const footer = 'Use Reply all so your answer reaches them and is recorded on the ticket.'
  await deliver({
    about:   p.fromEmail,
    subject: p.subject,
    html:    layoutHtml({ label: 'Ticket Reply', blocks: [para(esc(intro)), quoted('Their message', p.body || '(no text)')], footer }),
    text:    layoutText([intro, '', p.body || '(no text)'].join('\n'), footer),
    to:      { email: CONTACT_INBOX_EMAIL },
    replyTo: [{ email: p.fromEmail, name: p.fromName }, { email: ticketReplyEmail() }],
    what:    'ticket reply forward',
  })
}

/**
 * Staff answered a ticket without the client on the email (plain Reply on the
 * ticket email, which only reaches the reply address): send it on to the
 * client, CC the inbox, replies to the reply address.
 */
export async function sendTicketStaffReplyToClient(p: {
  subject: string; reference: string; clientName: string; clientEmail: string; body: string
}): Promise<void> {
  const intro  = `Hi ${p.clientName}, our team replied to your support ticket ${p.reference}:`
  const footer = 'To answer, simply reply to this email.'
  await deliver({
    subject: p.subject,
    html:    layoutHtml({ label: 'Support Ticket', blocks: [para(esc(intro)), quoted('Our reply', p.body || '(no text)')], footer }),
    text:    layoutText([intro, '', p.body || '(no text)'].join('\n'), footer),
    to:      { email: p.clientEmail, name: p.clientName },
    cc:      { email: CONTACT_INBOX_EMAIL },
    replyTo: { email: ticketReplyEmail() },
    what:    'ticket staff reply to client',
  })
}

// ── Reminders to the office and clients ────────────────────────────────────

/** A driver's license is about to expire: the office's copy (license-expiry.scheduler). */
export async function sendLicenseExpiryStaffEmail(p: {
  to:            string
  toName?:       string | null
  driverName:    string
  /** The driver's own address, so a seed driver's reminder is not emailed. */
  driverEmail?:  string | null
  licenseNumber: string | null
  expiresOn:     string
  daysLeft:      number
}): Promise<void> {
  const when = p.daysLeft === 0 ? 'today' : p.daysLeft === 1 ? 'tomorrow' : `in ${p.daysLeft} days`
  const intro =
    `${p.driverName}'s driver's license expires on ${p.expiresOn} (${when}). Once it expires they cannot be assigned ` +
    'to a delivery. When they renew, record the new license (photo and expiry) on their account in User Management.'
  const rows: Array<[string, string]> = [
    ['Driver',         p.driverName],
    ['License number', p.licenseNumber ?? 'Not on file'],
    ['Expires',        p.expiresOn],
  ]
  const footer = `This reminder was sent because a driver's license on ${APP_NAME} is about to expire.`

  await deliver({
    about:   p.driverEmail ?? null,
    subject: p.daysLeft === 0
      ? `Driver's license expires today: ${p.driverName}`
      : `Driver's license expires ${when}: ${p.driverName}`,
    html: layoutHtml({ label: 'License Expiry Reminder', blocks: [para(esc(intro)), detailRows(rows)], footer }),
    text: layoutText(`${intro}\n\n${rowsText(rows)}`, footer),
    to:   { email: p.to, name: p.toName },
    what: 'license expiry staff email',
  })
}

function contractWhen(daysLeft: number): string {
  if (daysLeft <= 0) return 'today'
  if (daysLeft === 1) return 'tomorrow'
  return `in ${daysLeft} days`
}

/** A client's contract is about to end: the client's copy (contract-expiry.scheduler). */
export async function sendContractExpiryClientEmail(p: {
  to:          string
  firstName:   string | null
  companyName: string | null
  expiresOn:   string
  daysLeft:    number
}): Promise<void> {
  const when    = contractWhen(p.daysLeft)
  const company = p.companyName?.trim() || 'your company'
  const intro =
    `Hi ${p.firstName?.trim() || 'there'}, the delivery contract between ${company} and ${APP_NAME} is valid until ` +
    `${p.expiresOn} (${when}). To keep booking deliveries without a break, please contact us to renew it. ` +
    'Once it ends, new bookings are closed; you can still sign in and view your data for 7 days, then sign-in closes until the contract is renewed.'
  const rows: Array<[string, string]> = [
    ['Company',     company],
    ['Valid until', p.expiresOn],
  ]
  const footer = `This reminder was sent because your ${APP_NAME} client contract is about to end.`

  await deliver({
    subject: p.daysLeft <= 0 ? `Your ${APP_NAME} contract ends today` : `Your ${APP_NAME} contract ends ${when}`,
    html:    layoutHtml({ label: 'Contract Renewal Reminder', blocks: [para(esc(intro)), detailRows(rows)], footer }),
    text:    layoutText(`${intro}\n\n${rowsText(rows)}`, footer),
    to:      { email: p.to, name: p.firstName },
    replyTo: { email: CONTACT_INBOX_EMAIL },
    what:    'contract expiry client email',
  })
}

/** A client's contract is about to end: the office's copy. */
export async function sendContractExpiryStaffEmail(p: {
  to:          string
  toName?:     string | null
  clientName:  string
  companyName: string | null
  clientEmail: string | null
  expiresOn:   string
  daysLeft:    number
}): Promise<void> {
  const when    = contractWhen(p.daysLeft)
  const company = p.companyName?.trim() || p.clientName
  const intro =
    `The contract with ${company} is valid until ${p.expiresOn} (${when}). Arrange the renewal with the client, ` +
    'then update "Contract Valid Until" on their account in User Management. After that date the client cannot book; ' +
    '7 days later they cannot sign in.'
  const rows: Array<[string, string]> = [
    ['Company',     company],
    ['Contact',     p.clientName],
    ['Email',       p.clientEmail ?? 'Not on file'],
    ['Valid until', p.expiresOn],
  ]
  const footer = `This reminder was sent because a client contract on ${APP_NAME} is about to end.`

  await deliver({
    about:   p.clientEmail,
    subject: p.daysLeft <= 0 ? `Client contract ends today: ${company}` : `Client contract ends ${when}: ${company}`,
    html:    layoutHtml({ label: 'Contract Expiry Reminder', blocks: [para(esc(intro)), detailRows(rows)], footer }),
    text:    layoutText(`${intro}\n\n${rowsText(rows)}`, footer),
    to:      { email: p.to, name: p.toName },
    what:    'contract expiry staff email',
  })
}

/**
 * A vendor driver was put on a booking. Vendor drivers can only sign in while
 * on an open booking (lib/vendor-access), so this email is how a signed-out
 * one learns they can sign in again.
 */
export async function sendVendorDriverAssignedEmail(p: {
  to:           string
  firstName:    string | null
  reference:    string
  scheduleDate: string | null
}): Promise<void> {
  const intro =
    `Hi ${p.firstName?.trim() || 'there'}, ${APP_NAME} has assigned you to delivery ${p.reference}. ` +
    'Open the 8338 driver app and sign in with this email address (your password or an emailed sign-in code) to see the details. ' +
    'You can use the app while you are on a delivery; it signs you out once the delivery is finished.'
  const rows: Array<[string, string]> = [
    ['Booking',   p.reference],
    ['Scheduled', p.scheduleDate ?? 'See the app'],
  ]
  const footer = `This email was sent because you are a vendor driver on ${APP_NAME}.`

  await deliver({
    subject: `New delivery for you: ${p.reference}`,
    html:    layoutHtml({ label: 'New Delivery Assigned', blocks: [para(esc(intro)), detailRows(rows)], footer }),
    text:    layoutText(`${intro}\n\n${rowsText(rows)}`, footer),
    to:      { email: p.to, name: p.firstName },
    what:    'vendor driver assigned email',
  })
}
