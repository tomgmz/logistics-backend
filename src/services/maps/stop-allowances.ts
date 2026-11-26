/**
 * Time allowances the live ETA adds on top of Google's drive time, and the
 * continuation instant of a paused delivery.
 *
 * The planned arrival per drop-off (planned-eta.service) was removed on
 * 2026-11-26 (user): drop-offs have the live ETA only, and Delayed is measured
 * at the pick-up point against the client's pick-up time (delay.scheduler).
 */

/** Unloading at each drop-off. A typical FMCG receiving bay; per-client later. */
export const UNLOAD_MINUTES_PER_STOP = 30

/** Loading at the pick-up point before a run, added to the drop-off ETAs while the truck is not loaded yet. */
export const LOAD_MINUTES_PER_TRIP = 45

/**
 * When the office expects a paused delivery to move again: the continuation
 * date + the driver's call time, PH time (fixed UTC+8). Null when none is set.
 */
export function continuationAt(date: string | null | undefined, callTime: string | null | undefined): number | null {
  const day = String(date ?? '').slice(0, 10)
  const hm  = String(callTime ?? '').slice(0, 8).replace(/^(\d{2}:\d{2})$/, '$1:00')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}$/.test(hm)) return null
  const at = Date.parse(`${day}T${hm}+08:00`)
  return Number.isFinite(at) ? at : null
}
