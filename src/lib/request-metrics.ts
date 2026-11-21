import type { NextFunction, Request, Response } from 'express'
import { supabase } from './supabase.js'

/**
 * Counts every API request into the current minute and writes the minute to
 * api_request_minutes once it is over: how many requests, how many the system
 * failed (5xx), how many were refused (4xx), and how long they took. These are
 * the traffic / errors / latency signals from Google's SRE book; the database
 * round trip timed once a minute is the saturation one.
 *
 * Counts only. No path, no user, no IP address (never-log-IPs rule).
 *
 * The write is additive (record_api_minute), so a restart mid-minute or a
 * second instance adds to the same row. A failed write is dropped with a
 * console line: metrics must never fail a request or log into system_logs on
 * every minute of an outage.
 */

interface Bucket {
  requests: number; server_errors: number; refused: number; total_ms: number
  under_300ms: number; under_1s: number; under_3s: number; over_3s: number; max_ms: number
}

const empty = (): Bucket => ({
  requests: 0, server_errors: 0, refused: 0, total_ms: 0,
  under_300ms: 0, under_1s: 0, under_3s: 0, over_3s: 0, max_ms: 0,
})

const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60_000

let current = { minute: minuteOf(Date.now()), b: empty() }
let timer: NodeJS.Timeout | null = null

// Health checks and CORS preflights aren't people using the system.
function skip(req: Request): boolean {
  return req.method === 'OPTIONS' || req.path === '/api/health' || req.path === '/'
}

function record(status: number, ms: number) {
  const now = Date.now()
  if (minuteOf(now) !== current.minute) rollOver()
  const b = current.b
  b.requests++
  if (status >= 500) b.server_errors++
  else if (status >= 400) b.refused++
  b.total_ms += ms
  if (ms < 300) b.under_300ms++
  else if (ms < 1000) b.under_1s++
  else if (ms < 3000) b.under_3s++
  else b.over_3s++
  if (ms > b.max_ms) b.max_ms = Math.round(ms)
}

export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  if (skip(req)) return next()
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    try {
      record(res.statusCode, Number(process.hrtime.bigint() - started) / 1e6)
    } catch { /* never let counting break a request */ }
  })
  next()
}

async function timeDatabase(): Promise<{ ms: number | null; failed: boolean }> {
  const t = Date.now()
  try {
    const { error } = await supabase.from('api_request_minutes').select('minute').limit(1)
    return { ms: Date.now() - t, failed: !!error }
  } catch {
    return { ms: null, failed: true }
  }
}

async function write(minute: number, b: Bucket) {
  const db = await timeDatabase()
  const { error } = await supabase.rpc('record_api_minute', {
    p_minute: new Date(minute).toISOString(),
    p_requests: b.requests, p_server_errors: b.server_errors, p_refused: b.refused,
    p_total_ms: Math.round(b.total_ms),
    p_under_300ms: b.under_300ms, p_under_1s: b.under_1s, p_under_3s: b.under_3s, p_over_3s: b.over_3s,
    p_max_ms: b.max_ms, p_db_ms: db.ms, p_db_failed: db.failed,
  })
  if (error) console.error('[request-metrics] write failed:', error.message)
}

function rollOver() {
  const done = current
  current = { minute: minuteOf(Date.now()), b: empty() }
  // A quiet minute is written too: it carries the database timing.
  void write(done.minute, done.b).catch((err) => console.error('[request-metrics] write threw:', err))
}

let lastPrune = 0
const KEEP_DAYS = 30

async function prune() {
  const before = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()
  const { error } = await supabase.from('api_request_minutes').delete().lt('minute', before)
  if (error) console.error('[request-metrics] prune failed:', error.message)
}

/** Writes each minute as it ends, even with no traffic; prunes once an hour. */
export function startRequestMetrics(): void {
  if (timer) return
  timer = setInterval(() => {
    if (minuteOf(Date.now()) !== current.minute) rollOver()
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now()
      void prune().catch(() => {})
    }
  }, 5_000)
  timer.unref?.()
}
