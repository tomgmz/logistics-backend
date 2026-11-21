import * as SystemLogModel from '../../models/admin/system-logs.model.js'
import * as IssueModel from '../../models/admin/system-log-issues.model.js'
import {
  GetSystemLogsQuery,
  GetSystemLogIssuesQuery,
  SystemLogIssueAction,
} from '../../types/system-logs.types.js'
import { logEvent } from '../../lib/log-event.js'

export async function getAllLogs(query: GetSystemLogsQuery) {
  return SystemLogModel.findAll(query)
}

export async function getLogById(logId: string) {
  const log = await SystemLogModel.findById(logId)
  if (!log) throw new Error('Log not found')
  return log
}

export async function getLogStats() {
  return SystemLogModel.getStats()
}

/**
 * The old per-row Resolve (a web version from before issues may still call it).
 * An error/critical row resolves its whole issue — the same thing the new
 * screens do; an info/warn row just has its own flag set as before.
 */
export async function setResolved(logId: string, resolved: boolean, actorId: string | null) {
  const issueId = await IssueModel.issueIdOfLog(logId)
  if (issueId === undefined) throw new Error('Log not found')
  if (issueId) {
    await actOnIssue(issueId, resolved ? { action: 'resolve' } : { action: 'reopen' }, actorId)
    return { log_id: logId, resolved }
  }
  const updated = await SystemLogModel.setResolved(logId, resolved)
  if (!updated) throw new Error('Log not found')
  return updated
}

// ── Issues ──────────────────────────────────────────────────────────────────

export async function getIssues(query: GetSystemLogIssuesQuery) {
  return IssueModel.findAll(query)
}

export async function getIssue(issueId: string) {
  const issue = await IssueModel.findById(issueId)
  if (!issue) throw new Error('Issue not found')
  return issue
}

/** Ignore lengths the screen offers; anything else is refused. null = until reopened. */
export const IGNORE_HOURS = [24, 24 * 7] as const

/**
 * Resolve, ignore or reopen one issue. A person did it, so it is an audit row
 * (logEvent), the same as any other admin decision.
 */
export async function actOnIssue(issueId: string, input: SystemLogIssueAction, actorId: string | null) {
  const before = await IssueModel.findById(issueId)
  if (!before) throw new Error('Issue not found')
  const now = new Date().toISOString()

  let updated
  if (input.action === 'resolve') {
    updated = await IssueModel.setStatus(issueId, {
      status: 'resolved', resolved_at: now, resolved_by: actorId, resolution: 'manual',
      ignored_until: null, ignored_by: null,
    })
  } else if (input.action === 'reopen') {
    updated = await IssueModel.setStatus(issueId, {
      status: 'open', resolved_at: null, resolved_by: null, resolution: null,
      ignored_until: null, ignored_by: null,
    })
  } else {
    const hours = input.hours ?? null
    if (hours !== null && !(IGNORE_HOURS as readonly number[]).includes(hours)) {
      throw new Error('Choose how long to ignore it')
    }
    updated = await IssueModel.setStatus(issueId, {
      status: 'ignored',
      ignored_until: hours === null ? null : new Date(Date.now() + hours * 3_600_000).toISOString(),
      ignored_by: actorId,
      resolved_at: null, resolved_by: null, resolution: null,
    })
  }
  if (!updated) throw new Error('Issue not found')

  const what = input.action === 'ignore'
    ? `Ignored ${input.hours ? `for ${input.hours === 24 ? '24 hours' : '7 days'}` : 'until reopened'}`
    : input.action === 'resolve' ? 'Resolved' : 'Reopened'
  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      `system_log_issue_${input.action === 'ignore' ? 'ignored' : input.action === 'resolve' ? 'resolved' : 'reopened'}`,
    description: `${what} system log issue "${before.title.slice(0, 160)}" (${before.source}, ${before.event_count} occurrence(s))`,
  })
  return updated
}

export const SYSTEM_EXPORT_ROW_CAP = 10000

/**
 * Rows for an Excel export of the system log. The file itself is built in the
 * browser: the Next proxy re-serialises every response as JSON, so a binary
 * body would not survive the trip.
 */
export async function exportLogs(query: GetSystemLogsQuery) {
  // One past the cap, so a full read tells us there was more behind it.
  const rows      = await SystemLogModel.findForExport(query, SYSTEM_EXPORT_ROW_CAP + 1)
  const truncated = rows.length > SYSTEM_EXPORT_ROW_CAP
  const exported  = truncated ? SYSTEM_EXPORT_ROW_CAP : rows.length

  // Audit, not system: a person took records out of the system in bulk, and
  // these carry stack traces and provider internals.
  const { event_type, log_level, resolved, search, sort } = query
  logEvent({
    log_type:    'data_export',
    action:      'system_logs_exported',
    description: `Exported ${exported} system log row(s)${truncated ? ` (capped at ${SYSTEM_EXPORT_ROW_CAP})` : ''}; filters: ${JSON.stringify({ event_type, log_level, resolved, search, sort })}`,
  })

  return { rows: truncated ? rows.slice(0, SYSTEM_EXPORT_ROW_CAP) : rows, truncated }
}
