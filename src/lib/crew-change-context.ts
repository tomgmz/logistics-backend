import type { PoolClient } from 'pg'

/**
 * Tell the deliveries trigger (log_crew_change, migration 20261121000000) who
 * is changing the crew and why, for this transaction only. Every change of
 * driver, second driver, helper or vehicle lands in booking_crew_changes
 * whatever path wrote it; this just names the person and the reason.
 *
 * `set_config(..., true)` is transaction-local, so it is safe on the
 * transaction pooler (no session state). Call it inside the transaction,
 * before the UPDATE/INSERT on deliveries.
 */
export type CrewChangeSource = 'assignment' | 'replaced' | 'swapped'

export async function setCrewChangeContext(
  client: PoolClient,
  ctx: { userId: string | null | undefined; source: CrewChangeSource; reason?: string | null },
): Promise<void> {
  await client.query(
    `SELECT set_config('app.actor_user_id', $1, true),
            set_config('app.crew_change_source', $2, true),
            set_config('app.crew_change_reason', $3, true)`,
    [ctx.userId ?? '', ctx.source, (ctx.reason ?? '').slice(0, 500)],
  )
}
