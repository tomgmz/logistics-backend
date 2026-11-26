import * as IssueModel from '../../models/admin/system-log-issues.model.js'
import * as M from '../../models/admin/it-dashboard.model.js'
import { getActiveStandinId } from '../../lib/it-standin.js'
import {
  AccountsSection,
  HealthPart,
  HealthState,
  TrafficPoint,
  TrafficSection,
  TrafficWindow,
  ItDashboardSummary,
  ItDashboardTrend,
  LockedAccount,
  ProblemsSection,
  RoleCounts,
  SchedulerHealth,
  SchedulerStatus,
  SecuritySection,
  SecurityWindow,
  ServiceHealth,
  ServiceStatus,
  StaffAccount,
  TrendLevel,
  TrendRange,
} from '../../types/it-dashboard.types.js'
import { SystemLogLevel, SystemLogEventType } from '../../types/system-logs.types.js'

const MIN  = 60_000
const HOUR = 60 * MIN
const DAY  = 24 * HOUR

/**
 * Every in-process scheduler, keyed by the `source` its heartbeat is logged
 * under. A new scheduler that logs a cron_job heartbeat belongs here, or the
 * dashboard cannot tell that it has stopped. The interval must match the
 * scheduler's own TICK_MS.
 */
const SCHEDULERS = [
  {
    source:           'fleet-recheck.scheduler',
    label:            'Fleet re-check reminders',
    description:      'Reminds the Fleet Manager to re-inspect trucks before dispatch.',
    interval_minutes: 15,
  },
  {
    source:           'completion.scheduler',
    label:            'Delivery auto-completion',
    description:      'Completes delivered bookings after 3 days and sends confirmation reminders.',
    interval_minutes: 15,
  },
  {
    source:           'driver-call.scheduler',
    label:            'Driver call time reminders',
    description:      'Notifies the assigned driver one hour before their call time.',
    interval_minutes: 5,
  },
  {
    source:           'breakdown.scheduler',
    label:            'Breakdown reminders',
    description:      'Reminds the Operations Manager and Company Administrator every 15 minutes about a driver-reported breakdown that has not been paused or dismissed.',
    interval_minutes: 5,
  },
  {
    source:           'late-confirmation.scheduler',
    label:            'Late confirmation reminders',
    description:      'Reminds the Operations Manager and Company Administrator every 15 minutes about a late drop-off confirmation (sent after a driver swap) still waiting to be accepted or dismissed.',
    interval_minutes: 5,
  },
  {
    source:           'delay.scheduler',
    label:            'Delayed delivery detection',
    description:      'Flags a booking whose truck has not reached the pick-up point by the client’s pick-up time, and tells the client and operations.',
    interval_minutes: 5,
  },
  {
    source:           'support-chat.scheduler',
    label:            'Client chat emails and closing',
    description:      'Emails a client the team replies they have not read within 15 minutes; closes assistant-only chats after 24 quiet hours; reminds a client who has not answered the team for 3 days and closes the conversation at 7.',
    interval_minutes: 5,
  },
  {
    source:           'late-start.scheduler',
    label:            'Late start detection',
    description:      'Flags a booking still Assigned 15 minutes after the driver call time: reminds the drivers once, tells the Operations Manager and Company Administrator and repeats every 30 minutes (for up to a day). The client is told by the Delayed check instead.',
    interval_minutes: 5,
  },
  {
    source:           'pause-continuation.scheduler',
    label:            'Paused delivery reminders',
    description:      'Reminds the drivers before a paused delivery continues; reminds operations every 30 minutes once its continuation time passes still paused, and about a pause with no continuation date (after 2 hours, then each morning); reminds operations every 15 minutes while a driver\'s "Ready to continue" is unanswered; tells the General Manager after 2 hours overdue, 1 day with no date, or 1 hour of an unanswered driver request.',
    interval_minutes: 5,
  },
  {
    source:           'license-expiry.scheduler',
    label:            'Driver license expiry reminders',
    description:      'Reminds each driver (app, push + email) and the Company Administrators and Operations Managers (app + push) 1 month, 3/2/1 weeks, 6 to 1 days before and on the day a license expires; the 8338 inbox gets an email at 1 month, 1 week and on the day.',
    interval_minutes: 60,
  },
  {
    source:           'registration-expiry.scheduler',
    label:            'Vehicle registration expiry reminders',
    description:      'Notifies Fleet Managers and Company Administrators (app + push) 1 month, 3/2/1 weeks, 6 to 1 days before and on the day a vehicle registration expires.',
    interval_minutes: 60,
  },
  {
    source:           'contract-expiry.scheduler',
    label:            'Client contract expiry reminders',
    description:      'Reminds the client and every Company Administrator, General Manager and Operations Manager (app, push + email) 1 month, 3/2/1 weeks, 6 to 1 days before and on the day a client contract ends.',
    interval_minutes: 60,
  },
  {
    source:           'it-admin-render.scheduler',
    label:            'IT Administrator handover',
    description:      'Finishes any IT Administrator handover whose replacement already set their password (normally done at once).',
    interval_minutes: 60,
  },
  {
    source:           'system-log-issues.scheduler',
    label:            'System log issue clean-up',
    description:      'Resolves a system log issue that has not happened again for 7 days; it reopens if it comes back.',
    interval_minutes: 60,
  },
  {
    source:           'tracking.pruneLocationHistory',
    label:            'Location history cleanup',
    description:      'Deletes truck position history past its retention period.',
    interval_minutes: 24 * 60,
  },
] as const

/**
 * External providers, by how their failures are logged. Only failures are
 * written for these, so a provider with no rows is "no failures recorded".
 * New call sites should log under one of these prefixes so they are counted.
 */
const SERVICES: { key: string; label: string; description: string; filter: (q: any) => any }[] = [
  {
    key:         'email',
    label:       'Email (Resend)',
    description: 'One-time codes, password resets, welcome and enrolment emails, and recording replies to support tickets.',
    // A recipient's server refusing one email (email.delivery; brevo.delivery
    // before Resend) is about that address, not the provider being down; those
    // rows stay in System Logs only.
    filter:      (q) => q.eq('event_type', 'email_event').not('source', 'in', '(email.delivery,brevo.delivery)'),
  },
  {
    key:         'storage',
    label:       'File storage (Cloudflare R2)',
    description: 'Proof photos, documents and every other uploaded file.',
    filter:      (q) => q.eq('event_type', 'external_api')
                         .or('source.eq.documents.service,source.like.storage.%'),
  },
  {
    key:         'google-maps',
    label:       'Google Maps',
    description: 'Directions, live arrival times, driver call time checks, route optimisation.',
    filter:      (q) => q.like('source', 'google-maps.%'),
  },
  {
    key:         'push',
    label:       'Push notifications',
    description: 'Mobile (Expo) and browser push delivery.',
    filter:      (q) => q.like('source', 'push.%'),
  },
  {
    key:         'idanalyzer',
    label:       'License scanning (ID Analyzer)',
    description: "Reads a driver's license photo, refuses other photos, flags fake or edited cards.",
    filter:      (q) => q.like('source', 'idanalyzer.%'),
  },
  {
    key:         'turnstile',
    label:       'Captcha (Cloudflare Turnstile)',
    description: 'Bot check on the landing page contact form. Refused visitors are not failures.',
    filter:      (q) => q.eq('event_type', 'external_api').like('source', 'turnstile.%'),
  },
  {
    key:         'gemini',
    label:       'Help assistant AI (Google Gemini)',
    description: "Answers every typed help question from the FAQ. When it fails, the assistant offers the closest common questions.",
    filter:      (q) => q.eq('event_type', 'external_api').like('source', 'gemini.%'),
  },
  {
    key:         'livekit',
    label:       'Emergency voice calls (LiveKit)',
    description: "The driver's in-app call to Operations after a quick alert.",
    filter:      (q) => q.like('source', 'livekit.%'),
  },
]

/** Sign-outs a person chose themselves are not a security signal. */
const SELF_SIGN_OUT_REASONS = ['logout', 'logout_all']

const DORMANT_DAYS = 90

/** Display order on the accounts card. Unknown roles sort after these. */
const ROLE_ORDER = [
  'admin', 'it_admin', 'general_manager', 'operations_manager', 'fleet_manager', 'driver', 'client',
]

/** `timestamp without time zone` comes back zone-less; it is UTC. */
function utc(ts: string | null | undefined): string | null {
  if (!ts) return null
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`
}

const iso = (ms: number) => new Date(ms).toISOString()

function fullName(u: { first_name: string | null; last_name: string | null; email: string }) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email
}

const MESSAGE_PREVIEW = 200

/**
 * A card-sized message. Some provider errors arrive as a whole HTML error page
 * (Cloudflare's 522 from Supabase, for one) — the <title> is the useful part.
 * The full text is still one click away in Logs.
 */
function preview(message: string | null | undefined): string | null {
  if (!message) return null
  const title = /<title>([\s\S]*?)<\/title>/i.exec(message)?.[1]
  const text  = (title ?? message).replace(/\s+/g, ' ').trim()
  return text.length > MESSAGE_PREVIEW ? `${text.slice(0, MESSAGE_PREVIEW - 1)}…` : text
}

// ── A ───────────────────────────────────────────────────────────────────────

async function problems(now: number): Promise<ProblemsSection> {
  // Open issues, not rows: 446 rows of one Resend outage are one problem.
  const openIssues = (level: 'critical' | 'error') =>
    IssueModel.count((q) => q.eq('status', 'open').eq('log_level', level))
  const dayIso = iso(now - DAY)
  const lastDay = (level: SystemLogLevel) =>
    M.countSystemLogs((q) => q.eq('log_level', level).gte('timestamp', dayIso))

  const [critical, error, dayCritical, dayError, dayWarn, latest] = await Promise.all([
    openIssues('critical'),
    openIssues('error'),
    lastDay('critical'),
    lastDay('error'),
    lastDay('warn'),
    IssueModel.latestOpen(8),
  ])

  return {
    unresolved:  { critical, error, warn: dayWarn },
    last_24h:    { critical: dayCritical, error: dayError, warn: dayWarn },
    open_issues: critical + error,
    latest:      latest.map((i) => ({
      log_id:      i.last_log_id ?? i.issue_id,
      issue_id:    i.issue_id,
      log_level:   i.log_level as SystemLogLevel,
      event_type:  i.event_type as SystemLogEventType,
      source:      i.source,
      message:     preview(i.last_message) ?? i.title,
      timestamp:   utc(i.last_seen)!,
      first_seen:  utc(i.first_seen)!,
      event_count: i.event_count,
      regressed:   !!i.regressed_at,
    })),
  }
}

// ── B ───────────────────────────────────────────────────────────────────────

function schedulerStatus(
  intervalMin: number,
  now: number,
  lastSuccess: number | null,
  lastError: number | null,
): SchedulerStatus {
  if (lastSuccess === null) return 'never'
  const age = now - lastSuccess
  const interval = intervalMin * MIN
  // Two missed ticks (plus slack for a slow tick or a restart) is late; four is
  // a process that is not running it any more.
  if (age > 4 * interval + 5 * MIN) return 'down'
  if (age > 2 * interval + 5 * MIN) return 'late'
  if (lastError !== null && lastError > lastSuccess) return 'failing'
  return 'ok'
}

async function schedulers(now: number): Promise<SchedulerHealth[]> {
  const since24h = iso(now - DAY)

  return Promise.all(SCHEDULERS.map(async (s) => {
    const base = (q: any) => q.eq('event_type', 'cron_job').eq('source', s.source)
    const [success, failure, errors24h] = await Promise.all([
      M.latestSystemLogs((q) => base(q).eq('log_level', 'info'), 1),
      M.latestSystemLogs((q) => base(q).in('log_level', ['error', 'critical']), 1),
      M.countSystemLogs((q) => base(q).in('log_level', ['error', 'critical']).gte('timestamp', since24h)),
    ])

    const lastSuccessAt = utc(success[0]?.timestamp)
    const lastErrorAt   = utc(failure[0]?.timestamp)

    return {
      source:             s.source,
      label:              s.label,
      description:        s.description,
      interval_minutes:   s.interval_minutes,
      status:             schedulerStatus(
        s.interval_minutes,
        now,
        lastSuccessAt ? Date.parse(lastSuccessAt) : null,
        lastErrorAt   ? Date.parse(lastErrorAt)   : null,
      ),
      last_success_at:    lastSuccessAt,
      last_success_note:  preview(success[0]?.message),
      last_error_at:      lastErrorAt,
      last_error_message: preview(failure[0]?.message),
      errors_24h:         errors24h,
    }
  }))
}

// ── C ───────────────────────────────────────────────────────────────────────

async function services(now: number): Promise<ServiceHealth[]> {
  const since = (ms: number) => iso(now - ms)

  return Promise.all(SERVICES.map(async (s) => {
    const failures = (q: any) => s.filter(q).neq('log_level', 'info')
    const [h1, h24, d7, last] = await Promise.all([
      M.countSystemLogs((q) => failures(q).gte('timestamp', since(HOUR))),
      M.countSystemLogs((q) => failures(q).gte('timestamp', since(DAY))),
      M.countSystemLogs((q) => failures(q).gte('timestamp', since(7 * DAY))),
      M.latestSystemLogs(failures, 1),
    ])

    const status: ServiceStatus = h1 > 0 ? 'failing' : h24 > 0 ? 'degraded' : 'ok'
    return {
      key:                  s.key,
      label:                s.label,
      description:          s.description,
      status,
      failures_1h:          h1,
      failures_24h:         h24,
      failures_7d:          d7,
      last_failure_at:      utc(last[0]?.timestamp),
      last_failure_message: preview(last[0]?.message),
    }
  }))
}

// ── D ───────────────────────────────────────────────────────────────────────

async function securityWindow(sinceIso: string): Promise<SecurityWindow> {
  const [
    failed_sign_ins, lockouts, rate_limit_trips, critical_auth_alerts,
    passkey_failures, reset_requests, passkeys_enrolled, sessions_revoked,
  ] = await Promise.all([
    M.countLoginHistory((q) => q.neq('attempt_status', 'success').gte('created_at', sinceIso)),
    M.countAuditLogs((q) => q.in('action', ['account_locked', 'account_permanently_locked']).gte('timestamp', sinceIso)),
    M.countSystemLogs((q) => q.like('source', 'rate-limit.%').gte('timestamp', sinceIso)),
    M.countSystemLogs((q) => q.eq('event_type', 'auth_event').eq('log_level', 'critical').gte('timestamp', sinceIso)),
    M.countSystemLogs((q) => q.eq('source', 'webauthn.service').neq('log_level', 'info').gte('timestamp', sinceIso)),
    M.countResetRequests((q) => q.gte('created_at', sinceIso)),
    M.countPasskeys((q) => q.gte('created_at', sinceIso)),
    // A revoke stamps expires_at with the moment it happened, so that column is
    // the revoke time for rows that carry a reason.
    M.countSessions((q) => q
      .not('revoked_reason', 'is', null)
      .not('revoked_reason', 'in', `(${SELF_SIGN_OUT_REASONS.join(',')})`)
      .gte('expires_at', sinceIso)),
  ])

  return {
    failed_sign_ins, lockouts, rate_limit_trips, critical_auth_alerts,
    passkey_failures, reset_requests, passkeys_enrolled, sessions_revoked,
  }
}

async function security(now: number, users: M.UserRow[]): Promise<SecuritySection> {
  const nowIso = iso(now)
  const [last_24h, last_7d, failedEmails, open_reset_requests, active_sessions] = await Promise.all([
    securityWindow(iso(now - DAY)),
    securityWindow(iso(now - 7 * DAY)),
    M.failedSignInEmails(iso(now - DAY), 2000),
    M.countResetRequests((q) => q.in('status', ['pending', 'sent'])),
    M.countSessions((q) => q.is('revoked_reason', null).gt('refresh_expires_at', nowIso)),
  ])

  const tally = new Map<string, number>()
  for (const email of failedEmails) {
    const key = email.trim().toLowerCase()
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const most_failed_accounts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([email, count]) => ({ email, count }))

  const locked_accounts: LockedAccount[] = users
    .filter((u) =>
      u.status === 'permanently_locked' ||
      (u.locked_until !== null && Date.parse(utc(u.locked_until)!) > now))
    .map((u) => ({
      user_id:      u.user_id,
      name:         fullName(u),
      email:        u.email,
      role:         u.role,
      permanent:    u.status === 'permanently_locked',
      locked_until: utc(u.locked_until),
    }))
    .sort((a, b) => Number(b.permanent) - Number(a.permanent))

  return { last_24h, last_7d, most_failed_accounts, locked_accounts, open_reset_requests, active_sessions }
}

// ── E ───────────────────────────────────────────────────────────────────────

function toStaff(u: M.UserRow): StaffAccount {
  return {
    user_id:       u.user_id,
    name:          fullName(u),
    email:         u.email,
    status:        u.status,
    last_login_at: utc(u.last_login_at),
    created_at:    utc(u.created_at),
  }
}

async function accounts(now: number, users: M.UserRow[]): Promise<AccountsSection> {
  const roles = new Map<string, RoleCounts>()
  for (const u of users) {
    const r = roles.get(u.role) ?? {
      role: u.role, active: 0, inactive: 0, archived: 0, permanently_locked: 0, total: 0,
    }
    if (u.status === 'active' || u.status === 'inactive' || u.status === 'archived' || u.status === 'permanently_locked') {
      r[u.status]++
    }
    r.total++
    roles.set(u.role, r)
  }
  const rank = (role: string) => {
    const i = ROLE_ORDER.indexOf(role)
    return i === -1 ? ROLE_ORDER.length : i
  }
  const by_role = [...roles.values()].sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role))

  const active = users.filter((u) => u.status === 'active')
  const dormantBefore = now - DORMANT_DAYS * DAY
  const never_signed_in = active.filter((u) => !u.last_login_at).length
  const dormant = active.filter((u) => u.last_login_at && Date.parse(utc(u.last_login_at)!) < dormantBefore).length

  const itAdmin = active.find((u) => u.role === 'it_admin') ?? null
  const standinId = await getActiveStandinId()
  const standin   = standinId ? active.find((u) => u.user_id === standinId) ?? null : null
  // it_admin_transitioned is the one-step handover used before 2026-10-25.
  const handover = await M.latestAuditByAction(['it_admin_handover_completed', 'it_admin_transitioned'])

  const administrators = users
    .filter((u) => u.role === 'admin' && u.status !== 'archived')
    .map(toStaff)
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    by_role,
    total_active: active.length,
    never_signed_in,
    dormant,
    dormant_days: DORMANT_DAYS,
    it_admin:      itAdmin ? toStaff(itAdmin) : null,
    it_standin:    standin ? toStaff(standin) : null,
    last_handover: handover ? { at: utc(handover.timestamp)!, description: handover.description } : null,
    administrators,
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

// ── Plain-language overview ─────────────────────────────────────────────────
//
// For a reader with no IT knowledge (user 2026-11-21). Same pattern as Apple's
// System Status and Atlassian Statuspage: each part of the system named the way
// a user would say it, a state word, and one sentence of why.

const fmtSeconds = (ms: number | null) => (ms === null ? 'an unknown time' : `${(ms / 1000).toFixed(1)} seconds`)
const n = (v: number) => v.toLocaleString('en-PH')
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`

function windowOf(rows: Awaited<ReturnType<typeof M.requestMinutes>>): TrafficWindow {
  let requests = 0, failed = 0, refused = 0, total = 0, slow = 0
  for (const r of rows) {
    requests += r.requests; failed += r.server_errors; refused += r.refused
    total += Number(r.total_ms); slow += r.over_3s
  }
  return { requests, failed, refused, slow, avg_ms: requests ? Math.round(total / requests) : null }
}

async function traffic(now: number): Promise<TrafficSection> {
  const [rows, first] = await Promise.all([
    M.requestMinutes(iso(now - DAY)),
    M.firstRequestMinute(),
  ])
  const t15 = now - 15 * MIN
  const recent = rows.filter((r) => Date.parse(r.minute) >= t15)
  const dbTimes = recent.map((r) => r.db_ms).filter((v): v is number => typeof v === 'number')

  // 24 hourly buckets (Manila is UTC+8, so whole hours line up with UTC).
  const startHour = Math.floor(now / HOUR) * HOUR - 23 * HOUR
  const hourly: TrafficPoint[] = Array.from({ length: 24 }, (_, i) => ({
    start: iso(startHour + i * HOUR), requests: 0, failed: 0, avg_ms: null,
  }))
  const totals = new Array<number>(24).fill(0)
  for (const r of rows) {
    const i = Math.floor((Date.parse(r.minute) - startHour) / HOUR)
    if (i < 0 || i > 23) continue
    hourly[i].requests += r.requests
    hourly[i].failed   += r.server_errors
    totals[i]          += Number(r.total_ms)
  }
  hourly.forEach((h, i) => { h.avg_ms = h.requests ? Math.round(totals[i] / h.requests) : null })

  return {
    last_15m:        windowOf(recent),
    last_24h:        windowOf(rows),
    db_avg_ms:       dbTimes.length ? Math.round(dbTimes.reduce((a, b) => a + b, 0) / dbTimes.length) : null,
    db_failures_15m: recent.filter((r) => r.db_failed).length,
    hourly,
    measured_since:  first,
  }
}

/** What each provider is called by the people who use it. */
const PLAIN_SERVICE: Record<string, { name: string; what: string; noun: string }> = {
  'email':       { name: 'Emails',               what: 'Sign-in codes, password resets, reminders and replies to support tickets.', noun: 'email' },
  'storage':     { name: 'Photos and documents', what: 'Saving and opening proof photos, licenses and documents.',                  noun: 'file' },
  'google-maps': { name: 'Maps and directions',  what: 'Routes, arrival times and the maps drivers and staff see.',                 noun: 'map request' },
  'push':        { name: 'Phone notifications',  what: "Alerts that pop up on drivers' and staff phones and browsers.",           noun: 'notification' },
  'idanalyzer':  { name: 'License scanning',     what: "Reading a driver's license from a photo.",                                 noun: 'scan' },
  'turnstile':   { name: 'Robot check',          what: 'Stops bots on the public contact form.',                                    noun: 'check' },
  'gemini':      { name: 'Help assistant',       what: "Answers clients' typed questions.",                                        noun: 'answer' },
  'livekit':     { name: 'Emergency calls',      what: "A driver's in-app call to Operations after an alert.",                     noun: 'call' },
}

function serviceHealth(s: ServiceHealth): HealthPart {
  const plain = PLAIN_SERVICE[s.key] ?? { name: s.label, what: s.description, noun: 'request' }
  const things = (v: number) => plural(v, plain.noun)
  let state: HealthState = 'working'
  let summary = 'No problems in the last 24 hours.'
  if (s.failures_1h >= 5) {
    state = 'down'
    summary = `${things(s.failures_1h)} failed in the last hour.`
  } else if (s.failures_1h > 0) {
    state = 'trouble'
    summary = `${things(s.failures_1h)} failed in the last hour.`
  } else if (s.failures_24h > 0) {
    summary = `Working now. ${things(s.failures_24h)} failed earlier today.`
  }
  return { key: s.key, name: plain.name, what: plain.what, state, summary, last_problem_at: s.last_failure_at }
}

function websiteHealth(t: TrafficSection): HealthPart {
  const w = t.last_15m
  const base = { key: 'website', name: 'Website and app', what: 'Signing in, bookings, tracking: everything people do in the system.' }
  if (!t.measured_since) {
    return { ...base, state: 'unknown', summary: 'Measuring has just started. Check back in a few minutes.', last_problem_at: null }
  }
  if (w.requests === 0) {
    return { ...base, state: 'working', summary: 'Quiet: nobody used the system in the last 15 minutes.', last_problem_at: null }
  }
  const failedShare = w.failed / w.requests
  const slowShare   = w.slow / w.requests
  let state: HealthState = 'working'
  if (w.requests >= 20 && failedShare >= 0.2) state = 'down'
  else if (failedShare >= 0.02 || w.failed >= 5 || slowShare >= 0.1 || (w.avg_ms ?? 0) >= 1500) state = 'trouble'
  const failedText = w.failed === 0 ? 'none failed' : `${n(w.failed)} failed`
  return {
    ...base, state, last_problem_at: null,
    summary: `${plural(w.requests, 'request')} in the last 15 minutes, ${failedText}. People waited about ${fmtSeconds(w.avg_ms)}.`,
  }
}

function databaseHealth(t: TrafficSection, dbErrors1h: number, lastDbError: string | null): HealthPart {
  const base = { key: 'database', name: 'Saving and loading data', what: 'Where every booking, account and record is kept.' }
  if (t.db_failures_15m >= 2) {
    return { ...base, state: 'down', summary: `Could not be reached ${plural(t.db_failures_15m, 'time')} in the last 15 minutes.`, last_problem_at: lastDbError }
  }
  const slow = (t.db_avg_ms ?? 0) >= 800
  if (t.db_failures_15m > 0 || dbErrors1h >= 3 || slow) {
    const why = slow
      ? `It is slow: about ${fmtSeconds(t.db_avg_ms)} per answer.`
      : `${plural(Math.max(dbErrors1h, t.db_failures_15m), 'problem')} in the last hour.`
    return { ...base, state: 'trouble', summary: why, last_problem_at: lastDbError }
  }
  if (t.db_avg_ms === null) {
    return { ...base, state: 'unknown', summary: 'No measurement yet. Check back in a few minutes.', last_problem_at: lastDbError }
  }
  return { ...base, state: 'working', summary: `Answers in about ${fmtSeconds(t.db_avg_ms)}.`, last_problem_at: lastDbError }
}

function tasksHealth(jobs: SchedulerHealth[]): HealthPart {
  const base = { key: 'tasks', name: 'Automatic tasks', what: 'Reminders, delay alerts and clean-ups the system runs on its own.' }
  const stopped = jobs.filter((j) => j.status === 'down')
  const late    = jobs.filter((j) => j.status === 'late')
  const failing = jobs.filter((j) => j.status === 'failing')
  const names = (js: SchedulerHealth[]) =>
    js.slice(0, 3).map((j) => j.label).join(', ') + (js.length > 3 ? ` and ${js.length - 3} more` : '')
  const lastErr = jobs.map((j) => j.last_error_at).filter((v): v is string => !!v).sort().pop() ?? null
  if (stopped.length) {
    return { ...base, state: 'down', summary: `${plural(stopped.length, 'task')} stopped running: ${names(stopped)}.`, last_problem_at: lastErr }
  }
  if (failing.length || late.length) {
    const parts = [
      failing.length ? `${plural(failing.length, 'task')} failing: ${names(failing)}` : null,
      late.length    ? `${plural(late.length, 'task')} running late: ${names(late)}` : null,
    ].filter(Boolean)
    return { ...base, state: 'trouble', summary: `${parts.join('. ')}.`, last_problem_at: lastErr }
  }
  const waiting = jobs.filter((j) => j.status === 'never').length
  const ran = jobs.length - waiting
  return {
    ...base, state: 'working', last_problem_at: lastErr,
    summary: waiting ? `${n(ran)} tasks running on time; ${plural(waiting, "task")} ${waiting === 1 ? "has" : "have"} not run yet since the last restart.` : `All ${n(ran)} tasks are running on time.`,
  }
}

async function health(now: number, t: TrafficSection, jobs: SchedulerHealth[], svc: ServiceHealth[]): Promise<HealthPart[]> {
  const [dbErrors1h, lastDb] = await Promise.all([
    M.countSystemLogs((q) => q.eq('event_type', 'db_event').in('log_level', ['error', 'critical']).gte('timestamp', iso(now - HOUR))),
    M.latestSystemLogs((q) => q.eq('event_type', 'db_event').in('log_level', ['error', 'critical']).gte('timestamp', iso(now - 7 * DAY)), 1),
  ])
  const byKey = new Map(svc.map((s) => [s.key, s]))
  return [
    websiteHealth(t),
    databaseHealth(t, dbErrors1h, utc(lastDb[0]?.timestamp)),
    ...['email', 'storage', 'google-maps', 'push', 'gemini', 'idanalyzer', 'livekit', 'turnstile']
      .map((k) => byKey.get(k)).filter((s): s is ServiceHealth => !!s).map(serviceHealth),
    tasksHealth(jobs),
  ]
}

export async function getSummary(): Promise<ItDashboardSummary> {
  const now = Date.now()
  // Read once, shared by the security and accounts sections.
  const users = await M.allUsers()

  const [p, sch, svc, sec, acc, trf] = await Promise.all([
    problems(now),
    schedulers(now),
    services(now),
    security(now, users),
    accounts(now, users),
    traffic(now),
  ])

  return {
    generated_at: iso(now),
    health:       await health(now, trf, sch, svc),
    traffic:      trf,
    problems:     p,
    schedulers:   sch,
    services:     svc,
    security:     sec,
    accounts:     acc,
  }
}

// ── Trend ───────────────────────────────────────────────────────────────────

/** Manila is UTC+8 all year (no daylight saving), so buckets are fixed offsets. */
const MANILA_OFFSET = 8 * HOUR

/** Where each bucket starts (UTC ms), oldest first; the last one is still filling. */
function bucketStarts(range: TrendRange, now: number): number[] {
  if (range === '24h') {
    // Manila and UTC hours line up: the offset is whole hours.
    const hour = Math.floor(now / HOUR) * HOUR
    return Array.from({ length: 24 }, (_, i) => hour - (23 - i) * HOUR)
  }
  if (range === '12m') {
    const local = new Date(now + MANILA_OFFSET)
    const y = local.getUTCFullYear(), m = local.getUTCMonth()
    return Array.from({ length: 12 }, (_, i) => Date.UTC(y, m - (11 - i), 1) - MANILA_OFFSET)
  }
  const days = range === '7d' ? 7 : 30
  const midnight = Math.floor((now + MANILA_OFFSET) / DAY) * DAY - MANILA_OFFSET
  return Array.from({ length: days }, (_, i) => midnight - (days - 1 - i) * DAY)
}

/**
 * One level's system_logs per bucket. A head-only count per bucket, like every
 * other read here, so the cost does not grow with the table (the
 * (log_level, timestamp) index carries each one): at most 30 + 1 counts.
 */
export async function getTrend(range: TrendRange, level: TrendLevel): Promise<ItDashboardTrend> {
  const now    = Date.now()
  const starts = bucketStarts(range, now)
  const first  = starts[0]
  const count  = (from: number, to: number) =>
    M.countSystemLogs((q) => q.eq('log_level', level).gte('timestamp', iso(from)).lt('timestamp', iso(to)))

  const [counts, previous_total] = await Promise.all([
    Promise.all(starts.map((s, i) => count(s, starts[i + 1] ?? now + MIN))),
    // The same length of time just before the range.
    count(first - (now - first), first),
  ])

  return {
    range,
    level,
    buckets:        starts.map((s, i) => ({ start: iso(s), count: counts[i] })),
    total:          counts.reduce((a, b) => a + b, 0),
    previous_total,
  }
}
