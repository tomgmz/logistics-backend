/**
 * PostgREST returns at most 1000 rows per request no matter what .range() asks
 * for, so a read bigger than that (an export) has to walk the result a page at
 * a time. `page(from, to)` must build a fresh, deterministically ordered query
 * each call — without a unique tie-breaker in the ORDER BY, rows sharing a sort
 * key can repeat or go missing across page boundaries.
 */
const PAGE_SIZE = 1000

export async function readInPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  cap: number,
): Promise<T[]> {
  const rows: T[] = []
  while (rows.length < cap) {
    const from = rows.length
    const to   = Math.min(from + PAGE_SIZE, cap) - 1
    const { data, error } = await page(from, to)
    if (error) throw error
    rows.push(...(data ?? []))
    // A short page means the table ran out before the cap did.
    if (!data || data.length < to - from + 1) break
  }
  return rows
}
