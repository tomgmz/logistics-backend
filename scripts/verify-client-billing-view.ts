/**
 * Checks what a CLIENT actually receives from the reverse billing API.
 *
 *   npx tsx scripts/verify-client-billing-view.ts
 *
 * The monthly cross-check is only a control if the client cannot see 8338's
 * figures before submitting their own. That rule is enforced in the service, so
 * this calls the service the way the route does — as a client viewer — and
 * asserts on the payload that would go over the wire.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import * as BillingService from '../src/services/billing/billing.service.js'

let passed = 0
const failures: string[] = []
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const { rows: clients } = await pool.query(
  `select distinct c.client_id, c.company_name, c.billing_mode, u.user_id
     from clients c
     join users u on u.user_id = c.user_id
     join bookings b on b.client_id = c.client_id and b.status = 'completed'`,
)

if (!clients.length) {
  console.log('No client has a completed booking — nothing to check.')
  await pool.end()
  process.exit(0)
}

for (const c of clients) {
  console.log(`\n${c.company_name} (${c.billing_mode})`)

  const viewer = { userId: c.user_id, role: 'client', clientId: c.client_id }

  // --- the list -----------------------------------------------------------
  const { rows } = await BillingService.listPeriods({}, viewer)
  console.log(`  ${rows.length} period(s) returned`)
  check('the client gets at least one period', rows.length > 0)

  const withWork = rows.filter((r) => Number((r as Record<string, unknown>).delivery_count ?? 0) > 0)
  check('delivery_count is present so empty periods can be hidden',
    rows.every((r) => 'delivery_count' in (r as object)))
  check('at least one period covers completed work', withWork.length > 0)

  // Every period must belong to this client and nobody else.
  check('every period belongs to this client',
    rows.every((r) => (r as { client_id: string }).client_id === c.client_id))

  if (c.billing_mode === 'monthly') {
    const sealed = rows.filter((r) => {
      const p = r as Record<string, unknown>
      return ['draft', 'consolidating', 'awaiting_submission'].includes(p.status as string)
    })
    check('pre-submission monthly periods report amounts_hidden',
      sealed.every((r) => (r as Record<string, unknown>).amounts_hidden === true))
    check('pre-submission monthly periods carry NO total',
      sealed.every((r) => (r as Record<string, unknown>).total_amount === null))
  }

  // --- the detail ---------------------------------------------------------
  const target = (withWork[0] ?? rows[0]) as { period_id: string; status: string }
  if (!target) continue

  const detail = (await BillingService.getPeriod(target.period_id, viewer)) as Record<string, unknown>
  const deliveries = (detail.deliveries ?? []) as { billed_amount: number | null; booking_id: string }[]

  console.log(`  detail for ${target.period_id.slice(0, 8)} — status ${target.status}, ${deliveries.length} delivery(ies)`)

  check('the detail lists the deliveries the period covers', Array.isArray(detail.deliveries))
  check('deliveries carry a booking reference', deliveries.every((d) => !!d.booking_id))

  if (c.billing_mode === 'monthly' &&
      ['draft', 'consolidating', 'awaiting_submission'].includes(target.status)) {
    check('8338 line items are withheld', detail.items === undefined)
    check('the period total is withheld', detail.total_amount === null)
    check('NO delivery leaks a price',
      deliveries.every((d) => d.billed_amount === null),
      `leaked: ${deliveries.filter((d) => d.billed_amount !== null).length}`)
  }

  // --- the scope is real completed work, not a sample ----------------------
  const { rows: real } = await pool.query(
    `select count(*)::int n from bookings
      where client_id = $1 and status = 'completed'
        and schedule_date between
          (select period_start from billing_periods where period_id = $2)
      and (select period_end   from billing_periods where period_id = $2)`,
    [c.client_id, target.period_id],
  )
  check('deliveries shown match the completed bookings in range',
    deliveries.length === real[0].n, `api ${deliveries.length} vs db ${real[0].n}`)

  // --- a client must not reach a period that is not theirs ----------------
  // Tested by pointing a viewer with a DIFFERENT client_id at this very
  // period, which exercises the ownership check directly rather than depending
  // on another client happening to have periods.
  const impostor = { userId: c.user_id, role: 'client', clientId: '00000000-0000-0000-0000-000000000000' }
  let blocked = false
  try {
    await BillingService.getPeriod(target.period_id, impostor)
  } catch {
    blocked = true
  }
  check("a client cannot read another client's period", blocked)

  // The list must be pinned to the caller too, not just the detail — asking for
  // someone else's client_id must not widen what comes back.
  const spoofed = await BillingService.listPeriods({ clientId: c.client_id }, impostor)
  check('the list ignores a client_id supplied by the caller',
    spoofed.rows.every((r) => (r as { client_id: string }).client_id !== c.client_id),
    `returned ${spoofed.rows.length} row(s) belonging to the target client`)
}

await pool.end()

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.log(`  x ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASSED — all ${passed} checks green`)
}
