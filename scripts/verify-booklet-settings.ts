/**
 * Checks the booklet settings, especially the guards on the serial counter.
 *
 *   npx tsx scripts/verify-booklet-settings.ts
 *
 * A wrong serial or ATP number puts incorrect regulatory text on every document
 * that follows, and neither mistake is visible in the UI afterwards — so the
 * warnings are the only thing standing between a typo and a bad BIR record.
 *
 * Whatever the booklets hold is captured up front and restored at the end.
 */
import 'dotenv/config'
import { pool } from '../src/lib/database.js'
import * as BillingService from '../src/services/billing/billing.service.js'
import { atpFooterFrom } from '../src/lib/pdf/bir-document.js'

let passed = 0
const failures: string[] = []
const ok = (l: string) => { passed++; console.log(`  ok   ${l}`) }
const bad = (l: string, d = '') => { failures.push(`${l}${d ? ` — ${d}` : ''}`); console.log(`  FAIL ${l}${d ? ` — ${d}` : ''}`) }
const check = (l: string, cond: boolean, d = '') => (cond ? ok(l) : bad(l, d))

const KEY = 'service_invoice' as const
let original: Record<string, unknown> | null = null

try {
  const { rows } = await pool.query('select * from document_series where series_key = $1', [KEY])
  original = rows[0]
  if (!original) throw new Error('no service_invoice booklet row')

  console.log(`\nstarting from next_number = ${original.next_number}, range ${original.booklet_start}–${original.booklet_end}\n`)

  console.log('Reading')
  const all = await BillingService.listBooklets()
  check('both booklets are returned', all.length === 2, `got ${all.length}`)
  check('each carries its own ATP number',
    new Set(all.map((b) => b.atp_number)).size === 2,
    'the two pads are registered separately and must not share one')

  console.log('\nFooter mapping')
  const footer = atpFooterFrom(all.find((b) => b.series_key === KEY) as never)
  check('the ATP line is labelled, not raw', footer.authority.startsWith('BIR Authority to Print No. '))
  check('the ATP number is carried through', footer.authority.includes(String(original.atp_number)))
  check('a missing value prints empty, not a placeholder',
    atpFooterFrom(null).authority === '',
    'a gap is visibly incomplete; "N/A" could pass review unnoticed')

  console.log('\nSafe edits apply straight away')
  const forward = await BillingService.updateBooklet(
    KEY, { next_number: Number(original.next_number) + 5 }, null,
  )
  check('moving the serial forward needs no confirmation', !forward.requires_confirmation)
  check('and is written', Number(forward.series.next_number) === Number(original.next_number) + 5)

  console.log('\nRisky edits warn first')
  const backwards = await BillingService.updateBooklet(KEY, { next_number: 1 }, null)
  check('moving the serial BACKWARDS asks for confirmation', backwards.requires_confirmation)
  check('and says why', backwards.warnings.some((w) => /backwards/i.test(w)))
  const afterWarn = await pool.query('select next_number from document_series where series_key = $1', [KEY])
  check('*** nothing was written while unconfirmed ***',
    Number(afterWarn.rows[0].next_number) === Number(original.next_number) + 5)

  const outside = await BillingService.updateBooklet(
    KEY, { next_number: Number(original.booklet_end ?? 500) + 50 }, null,
  )
  check('a serial outside the pad range warns', outside.requires_confirmation)
  check('and names the range', outside.warnings.some((w) => /outside the booklet range/i.test(w)))

  console.log('\nConfirming applies it')
  const confirmed = await BillingService.updateBooklet(
    KEY, { next_number: 1, acknowledge_warnings: true }, null,
  )
  check('acknowledged, the change goes through', !confirmed.requires_confirmation)
  check('a fresh pad can legitimately reset to 1', Number(confirmed.series.next_number) === 1)

  console.log('\nATP text is stored verbatim')
  const odd = 'OCN 057AU9999000099999'
  const saved = await BillingService.updateBooklet(
    KEY, { atp_number: odd, atp_date: '01-02-2027' }, null,
  )
  check('the ATP number round-trips unchanged', saved.series.atp_number === odd)
  check('the date is NOT reformatted', saved.series.atp_date === '01-02-2027',
    'it is printed exactly as it appears on the pad')

  console.log('\nThe key itself is not writable')
  const spoof = await BillingService.updateBooklet(
    KEY, { series_key: 'acknowledgement_receipt' } as never, null,
  )
  check('series_key cannot be changed', spoof.series.series_key === KEY,
    'changing it would move one pad’s counter onto the other')

  const unknown = await BillingService.updateBooklet(
    'nope' as never, { next_number: 1 }, null,
  ).then(() => 'no error').catch((e) => (e as Error).message)
  check('an unknown booklet is rejected', /unknown booklet/i.test(String(unknown)), String(unknown))
} catch (err) {
  bad('harness', (err as Error).message)
} finally {
  if (original) {
    const cols = Object.keys(original).filter((k) => k !== 'series_key')
    await pool.query(
      `update document_series set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
        where series_key = $1`,
      [KEY, ...cols.map((c) => original![c])],
    )
    const { rows } = await pool.query('select next_number, atp_number from document_series where series_key = $1', [KEY])
    console.log(`\nrestored: next_number = ${rows[0].next_number}, ATP ${rows[0].atp_number}`)
  }
  await pool.end()
}

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`)
  for (const f of failures) console.log(`  x ${f}`)
  process.exitCode = 1
} else {
  console.log(`PASSED — all ${passed} checks green`)
}
