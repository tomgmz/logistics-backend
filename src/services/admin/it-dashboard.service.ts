import * as M from '../../models/admin/it-dashboard.model.js'
import {
  AccountsSection,
  DashboardLogRow,
  ItDashboardSummary,
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
    label:       'Email (Brevo)',
    description: 'One-time codes, password resets, welcome and enrolment emails.',
    filter:      (q) => q.eq('event_type', 'email_event'),
  },
  {
    key:         'cloudinary',
    label:       'File storage (Cloudinary)',
    description: 'Proof photos, documents and every other uploaded file.',
    filter:      (q) => q.eq('event_type', 'external_api')
                         .in('source', ['uploadDocument.service', 'documents.service']),
  },
  {
    key:         'google-maps',
    label:       'Google Maps',
    description: 'Directions, live and planned arrival times, route optimisation.',
    filter:      (q) => q.like('source', 'google-maps.%'),
  },
  {
    key:         'push',
    label:       'Push notifications',
    description: 'Mobile (Expo) and browser push delivery.',
    filter:      (q) => q.like('source', 'push.%'),
  },
  {
    key:         'google-vision',
    label:       'Licence scanning (Google Vision)',
    description: "Reads driver's licence details from a photo.",
    filter:      (q) => q.like('source', 'google-vision.%'),
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

function toLogRow(r: Awaited<ReturnType<typeof M.latestSystemLogs>>[number]): DashboardLogRow {
  return {
    log_id:     r.log_id,
    log_level:  r.log_level as SystemLogLevel,
    event_type: r.event_type as SystemLogEventType,
    source:     r.source,
    message:    preview(r.message) ?? '',
    timestamp:  utc(r.timestamp)!,
  }
}

// ── A ───────────────────────────────────────────────────────────────────────

async function problems(): Promise<ProblemsSection> {
  const unresolved = (level: SystemLogLevel) =>
    M.countSystemLogs((q) => q.eq('resolved', false).eq('log_level', level))

  const [critical, error, warn, latest] = await Promise.all([
    unresolved('critical'),
    unresolved('error'),
    unresolved('warn'),
    M.latestSystemLogs((q) => q.eq('resolved', false).in('log_level', ['critical', 'error']), 5),
  ])

  return { unresolved: { critical, error, warn }, latest: latest.map(toLogRow) }
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
  const handover = await M.latestAuditByAction('it_admin_transitioned')

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
    last_handover: handover ? { at: utc(handover.timestamp)!, description: handover.description } : null,
    administrators,
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

export async function getSummary(): Promise<ItDashboardSummary> {
  const now = Date.now()
  // Read once, shared by the security and accounts sections.
  const users = await M.allUsers()

  const [p, sch, svc, sec, acc] = await Promise.all([
    problems(),
    schedulers(now),
    services(now),
    security(now, users),
    accounts(now, users),
  ])

  return {
    generated_at: iso(now),
    problems:     p,
    schedulers:   sch,
    services:     svc,
    security:     sec,
    accounts:     acc,
  }
}
