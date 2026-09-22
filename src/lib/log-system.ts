import { supabase } from './supabase.js'
import { getRequestContext } from './request-context.js'
import { SystemLogLevel, SystemLogEventType } from '../types/system-logs.types.js'

/**
 * Writes one row to the technical system log: what the software did, or failed
 * to do. Most rows have no human behind them at all.
 *
 * The distinction against logEvent() is the subject, not the severity. A person
 * deleting a document is an audit row even though it is routine; Cloudinary
 * refusing that delete is a system row even though the same click caused it.
 *
 * This function must never throw and must never reject. It is called from the
 * global error handler and from catch blocks, i.e. from places that are already
 * handling a failure — if logging the failure could itself fail, the original
 * error would be lost. Hence the try/catch around the insert AND the .catch on
 * the promise.
 */
export interface SystemLogInput {
  log_level:   SystemLogLevel
  event_type:  SystemLogEventType
  /** Module it came from, e.g. 'fleet-recheck.scheduler'. A grep target. */
  source:      string
  message:     string
  metadata?:   Record<string, unknown>
  user_id?:    string | null
}

/** Stack traces are useful but unbounded; Postgres rows are not. */
const MAX_MESSAGE = 4000
const MAX_METADATA_CHARS = 8000

function safeMetadata(meta: Record<string, unknown> | undefined, ctx: ReturnType<typeof getRequestContext>) {
  const merged = {
    ...(meta ?? {}),
    ...(ctx?.requestId && { request_id: ctx.requestId }),
    ...(ctx?.path      && { path: ctx.path }),
    ...(ctx?.method    && { method: ctx.method }),
  }
  if (!Object.keys(merged).length) return null

  try {
    const json = JSON.stringify(merged)
    if (json.length <= MAX_METADATA_CHARS) return merged
    // Too big to store whole — keep the request identifiers, drop the payload,
    // and say so rather than silently truncating into invalid JSON.
    return {
      request_id: ctx?.requestId ?? null,
      path:       ctx?.path      ?? null,
      truncated:  `metadata omitted (${json.length} chars)`,
    }
  } catch {
    // Circular references, BigInt, etc. Never let serialisation sink the log.
    return { serialization_failed: true, request_id: ctx?.requestId ?? null }
  }
}

export function logSystem(input: SystemLogInput): void {
  try {
    const ctx = getRequestContext()

    const row = {
      log_level:  input.log_level,
      event_type: input.event_type,
      source:     input.source,
      message:    (input.message ?? '').slice(0, MAX_MESSAGE),
      metadata:   safeMetadata(input.metadata, ctx),
      user_id:    input.user_id    ?? ctx?.userId ?? null,
    }

    supabase.from('system_logs').insert(row).then(
      ({ error }) => {
        // Deliberately console-only: escalating a system-log failure into
        // another system-log write is how you build an infinite loop.
        if (error) console.error('[logSystem] insert failed:', error.message, '|', row.message)
      },
      (err: unknown) => console.error('[logSystem] insert threw:', err),
    )
  } catch (err) {
    console.error('[logSystem] threw before insert:', err)
  }
}

/** Convenience for catch blocks: turns an unknown throw into a system row. */
export function logSystemError(
  source: string,
  event_type: SystemLogEventType,
  err: unknown,
  metadata?: Record<string, unknown>,
): void {
  const e = err as { message?: string; stack?: string; code?: string | number; status?: number }
  logSystem({
    log_level:  'error',
    event_type,
    source,
    message:    e?.message ?? String(err),
    metadata:   { ...(metadata ?? {}), stack: e?.stack, code: e?.code, status: e?.status },
  })
}

export default logSystem
