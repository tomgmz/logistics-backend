/**
 * A length of time as the app writes it everywhere (same rule as the web's and
 * the driver app's lib/duration.ts): minutes under an hour, hours under a day,
 * days after that. Rounded down, one unit (user 2026-11-02).
 *   25 → "25 min" · 90 → "1 hr" · 300 → "5 hrs" · 1500 → "1 day" · 3000 → "2 days"
 */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ${h === 1 ? 'hr' : 'hrs'}`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}
