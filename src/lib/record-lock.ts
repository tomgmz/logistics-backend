import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { supabase } from './supabase.js'
import { broadcast } from './realtime.js'
import { HttpError } from './http-error.js'

/**
 * Record locks — one staff member edits a record at a time.
 *
 * Two layers, both backed by `record_locks` (migration 20260925000000):
 *
 *  1. A screen that opens a record for editing acquires its lock and keeps it
 *     alive with a heartbeat. Everyone else's screen sees "X is updating this"
 *     and renders read-only. That is the frontend half — see /api/locks.
 *
 *  2. Every guarded write goes through `lockGuard`, which takes the same lock
 *     for the duration of the request. The screen lock is a courtesy; THIS is
 *     the gate. Two assignments racing for the same booking cannot both pass it,
 *     whatever the screens showed, and a write from a screen whose lock lapsed
 *     and passed to a colleague is refused rather than silently overwriting them.
 *
 * Each successful guarded write bumps the record's `write_seq`. A screen that
 * gains the lock at a higher seq than it loaded reloads first, so a stale copy
 * never becomes the basis of the next write.
 *
 * Lock events go out on `record-locks:<type>` carrying only the record id —
 * never who holds it. The realtime channel is reachable with the public anon
 * key, so names are fetched through the authenticated API instead.
 */

/**
 * The kinds of record that can be locked. A whitelist, because the lock API
 * takes the type from the URL: without it any string would mint a lock row.
 */
export const LOCK_TYPES = [
  'booking',          // booking + its crew, trips, destinations, approval
  'user',             // every account kind: admins, clients, drivers, GM, fleet, ops, IT; permissions
  'truck',            // vehicle record + its BLOWBAGETS inspections
  'truck_model',
  'driver_report',
  'password_reset',
  'handling_code',
  'commodity',
  'product',
  'landline_prefix',
] as const

export type LockType = (typeof LOCK_TYPES)[number]

export function isLockType(value: string): value is LockType {
  return (LOCK_TYPES as readonly string[]).includes(value)
}

/** How long a screen's lock lives without a heartbeat. Screens renew every 20s. */
export const SCREEN_LOCK_TTL_SECONDS = 60

/** How long the write guard's own lock lives — a ceiling on one request. */
const REQUEST_LOCK_TTL_SECONDS = 30

export interface LockState {
  acquired:       boolean
  was_held:       boolean
  holder_id:      string | null
  holder_name:    string | null
  expires_at:     string | null
  write_seq:      number
  last_writer_id: string | null
}

/** What the API tells a screen. Ids are reduced to "is it me". */
export interface LockView {
  resource_type:     LockType
  resource_id:       string
  locked:            boolean
  held_by_me:        boolean
  holder_name:       string | null
  expires_at:        string | null
  write_seq:         number
  last_write_by_me:  boolean
}

export function toView(type: LockType, id: string, state: LockState | null, userId: string): LockView {
  const live = !!state?.holder_id && !!state.expires_at && new Date(state.expires_at).getTime() > Date.now()
  return {
    resource_type:    type,
    resource_id:      id,
    locked:           live,
    held_by_me:       live && state!.holder_id === userId,
    holder_name:      live ? state!.holder_name : null,
    expires_at:       live ? state!.expires_at : null,
    write_seq:        Number(state?.write_seq ?? 0),
    last_write_by_me: !!state?.last_writer_id && state.last_writer_id === userId,
  }
}

// ── Holder names ────────────────────────────────────────────────────────────
// Looked up server-side, never taken from the request: the banner other staff
// see must say who really holds the lock. Cached briefly — a heartbeat every
// 20s per open screen should not cost a users query each time.

const nameCache = new Map<string, { name: string; at: number }>()
const NAME_TTL_MS = 5 * 60 * 1000

async function displayName(userId: string): Promise<string> {
  const hit = nameCache.get(userId)
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.name

  const { data } = await supabase
    .from('users')
    .select('first_name, last_name, email')
    .eq('user_id', userId)
    .maybeSingle()

  const name = [data?.first_name, data?.last_name].filter(Boolean).join(' ').trim()
    || data?.email
    || 'Another user'
  nameCache.set(userId, { name, at: Date.now() })
  return name
}

// ── Primitives ──────────────────────────────────────────────────────────────

function notifyChanged(type: LockType, id: string): void {
  void broadcast(`record-locks:${type}`, 'changed', { id }).catch((err) => {
    console.warn('[record-lock] broadcast failed', type, id, err)
  })
}

export async function acquireLock(
  type:       LockType,
  id:         string,
  userId:     string,
  ttlSeconds: number = SCREEN_LOCK_TTL_SECONDS,
): Promise<LockState> {
  const { data, error } = await supabase.rpc('acquire_record_lock', {
    p_type:        type,
    p_id:          id,
    p_holder:      userId,
    p_holder_name: await displayName(userId),
    p_ttl_seconds: ttlSeconds,
  })
  if (error) throw error

  const row = (Array.isArray(data) ? data[0] : data) as LockState
  // Only a change of hands is news; a heartbeat renewing the same lock is not.
  if (row.acquired && !row.was_held) notifyChanged(type, id)
  return row
}

export async function releaseLock(type: LockType, id: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('release_record_lock', {
    p_type: type, p_id: id, p_holder: userId,
  })
  if (error) throw error
  if (data) notifyChanged(type, id)
  return !!data
}

export async function getLock(type: LockType, id: string): Promise<LockState | null> {
  const { data, error } = await supabase
    .from('record_locks')
    .select('holder_id, holder_name, expires_at, write_seq, last_writer_id')
    .eq('resource_type', type)
    .eq('resource_id', id)
    .maybeSingle()
  if (error) throw error
  return data ? ({ acquired: false, was_held: false, ...data } as LockState) : null
}

/** Live locks of one type, for list screens that badge "being edited" rows. */
export async function listActiveLocks(type: LockType): Promise<Array<LockState & { resource_id: string }>> {
  const { data, error } = await supabase
    .from('record_locks')
    .select('resource_id, holder_id, holder_name, expires_at, write_seq, last_writer_id')
    .eq('resource_type', type)
    .not('holder_id', 'is', null)
    .gt('expires_at', new Date().toISOString())
  if (error) throw error
  return (data ?? []).map((r) => ({ acquired: false, was_held: false, ...r })) as any
}

async function bumpWrite(type: LockType, id: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('bump_record_write', {
    p_type: type, p_id: id, p_writer: userId,
  })
  if (error) throw error
  notifyChanged(type, id)
}

/** Human noun for the 423 message. */
const NOUN: Record<LockType, string> = {
  booking:         'this booking',
  user:            'this account',
  truck:           'this vehicle',
  truck_model:     'this truck model',
  driver_report:   'this report',
  password_reset:  'this reset request',
  handling_code:   'this handling code',
  commodity:       'this commodity',
  product:         'this product',
  landline_prefix: 'this landline prefix',
}

export function lockedError(type: LockType, holderName: string | null): HttpError {
  return new HttpError(
    423,
    `${holderName ?? 'Another user'} is currently updating ${NOUN[type]}. ` +
    `Your change was not saved — try again once they are done.`,
  )
}

/**
 * Missing infrastructure (migration not applied yet) must not take every write
 * in the admin down with it. These are "the function/table does not exist".
 */
export function isMissingLockInfra(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205'
}

// ── The write guard ─────────────────────────────────────────────────────────

export type LockIdResolver = (req: Request) => string | null | undefined | Promise<string | null | undefined>

/** A drop-off's parent booking — destination routes lock the whole booking. */
export const bookingOfDestination = (param: string): LockIdResolver => async (req) => {
  const raw = req.params[param]
  const destinationId = Array.isArray(raw) ? raw[0] : raw
  if (!destinationId) return null
  const { data, error } = await supabase
    .from('booking_destinations')
    .select('booking_id')
    .eq('destination_id', destinationId)
    .maybeSingle()
  if (error) throw error
  return data?.booking_id ?? null
}

/** Resolve the id straight from a route param. */
export const fromParam = (name: string): LockIdResolver => (req) => {
  const v = req.params[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * Serialise writes to one record across users.
 *
 *  - Someone else holds the lock → 423, and the handler never runs.
 *  - The caller holds it (their screen took it) → proceed; leave it held.
 *  - Nobody holds it → take it for this request only, release when the
 *    response finishes. A caller without a lock-aware screen (an older tab, a
 *    script) still cannot interleave with a concurrent write.
 *
 * After a successful (2xx) response the record's write_seq is bumped, which is
 * how other screens learn their copy is out of date.
 */
export function lockGuard(type: LockType, resolveId: LockIdResolver): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.sub
    if (!userId) return next() // authenticate runs first; nothing to key a lock on

    let id: string | null | undefined
    try {
      id = await resolveId(req)
    } catch (err) {
      return next(err)
    }
    // Unknown record: let the handler produce its own 404.
    if (!id) return next()

    let state: LockState
    try {
      state = await acquireLock(type, id, userId, REQUEST_LOCK_TTL_SECONDS)
    } catch (err) {
      if (isMissingLockInfra(err)) {
        console.warn('[record-lock] record_locks migration not applied — write guard is OFF')
        return next()
      }
      return next(err)
    }

    if (!state.acquired) {
      // A client told "Juan from operations is editing" learns a staff
      // member's name for no benefit; outside callers get a neutral message.
      const outsider = req.user?.role === 'client' || req.user?.role === 'driver'
      const holder   = outsider ? 'Our team' : state.holder_name
      const e = lockedError(type, holder)
      res.status(e.status).json({
        status:  'error',
        code:    'RECORD_LOCKED',
        message: e.message,
        lock:    { holder_name: holder, expires_at: state.expires_at },
      })
      return
    }

    const tookForRequest = !state.was_held
    // 'close' fires whether the response finished or the client went away, so
    // a request-scoped lock is never left to run out its TTL. headersSent keeps
    // an aborted request's default 200 from counting as a write.
    res.once('close', () => {
      const ok = res.headersSent && res.statusCode >= 200 && res.statusCode < 300
      void (async () => {
        if (ok) await bumpWrite(type, id!, userId)
        if (tookForRequest) await releaseLock(type, id!, userId)
      })().catch((err) => console.warn('[record-lock] post-write bookkeeping failed', type, id, err))
    })

    next()
  }
}
