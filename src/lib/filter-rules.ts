/**
 * The web Filters panel's rules (components/ui/FilterBar.tsx), applied on the
 * server for tables that page there: [{ field, op: 'is' | 'is_not', value }].
 * Rules on one field: any "is" matches, every "is not" must hold.
 */

export interface FilterRule { field: string; op: 'is' | 'is_not'; value: string }

export function splitRules(rules: FilterRule[], field: string) {
  const is: string[] = [], not: string[] = []
  for (const r of rules) if (r.field === field) (r.op === 'is' ? is : not).push(r.value)
  return { is, not }
}

/** True when the rules on `field` let `value` through. */
export function matchesFilter(rules: FilterRule[], field: string, value: string | null | undefined): boolean {
  const { is, not } = splitRules(rules, field)
  if (is.length && (value == null || !is.includes(value))) return false
  return value == null || !not.includes(value)
}

/** The values `field` is narrowed to (out of `universe`), or null when nothing narrows it. */
export function allowedValues(rules: FilterRule[], field: string, universe: string[]): string[] | null {
  const { is, not } = splitRules(rules, field)
  if (!is.length && !not.length) return null
  return (is.length ? is : universe).filter((v) => !not.includes(v))
}

/** The rules from a query param (JSON); anything malformed is ignored. */
export function parseFilterRules(raw: unknown): FilterRule[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is FilterRule =>
      r && typeof r.field === 'string' && (r.op === 'is' || r.op === 'is_not') && typeof r.value === 'string')
  } catch {
    return []
  }
}
