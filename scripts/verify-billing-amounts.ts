/**
 * Checks src/lib/billing-amounts.ts — the figures that get printed on BIR
 * documents.
 *
 *   npx tsx scripts/verify-billing-amounts.ts
 */
import { amountInWords, computeInvoiceTotals, formatPeso } from '../src/lib/billing-amounts.js'

let passed = 0
const failures: string[] = []

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`)
}

function throws(label: string, fn: () => unknown): void {
  try { fn(); failures.push(`${label}\n      expected a throw`) } catch { passed++ }
}

// The worked example: four bookings consolidating to a 67,100 cut-off.
console.log('\nService Invoice totals — no discount, no withholding')
const plain = computeInvoiceTotals({ grossTotal: 67100 })
check('total sales is VAT inclusive', plain.total_sales_vat_inclusive, 67100)
check('net of VAT',                   plain.net_of_vat, 59910.71)
check('VAT 12%',                      plain.vat_amount, 7189.29)
check('VAT + net reconstitutes gross', plain.net_of_vat + plain.vat_amount, 67100)
check('nothing withheld',             plain.withholding_tax_amount, 0)
check('total due equals gross',       plain.total_amount_due, 67100)

console.log('Service Invoice totals — 2% creditable withholding')
const ewt = computeInvoiceTotals({ grossTotal: 67100, withholdingTaxRate: 2 })
check('withholding is 2% of the NET, not the gross', ewt.withholding_tax_amount, 1198.21)
check('total due', ewt.total_amount_due, 65901.79)
check('client remits gross less the withholding',
  Number((ewt.total_amount_due + ewt.withholding_tax_amount).toFixed(2)), 67100)

console.log('Service Invoice totals — discount then VAT then withholding')
const disc = computeInvoiceTotals({ grossTotal: 67100, discountRate: 10, withholdingTaxRate: 2 })
check('discount comes off the net', disc.discount_amount, 5991.07)
check('total due', disc.total_amount_due, 59311.61)

// The property that actually matters on a printed form: each component is
// rounded to centavos, and the components as PRINTED must reconcile to the
// printed total. Chaining unrounded floats instead would leave the visible
// lines a centavo short of the visible total.
const discountedNet = Number((disc.net_of_vat - disc.discount_amount).toFixed(2))
check('printed lines reconcile to the printed total',
  Number((discountedNet + 6470.36 - disc.withholding_tax_amount).toFixed(2)),
  disc.total_amount_due)
for (const [label, v] of Object.entries(disc)) {
  if (label.endsWith('_rate')) continue
  if (Math.round(v * 100) !== v * 100 && Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
    failures.push(`${label} is not a whole number of centavos: ${v}`)
  } else passed++
}

console.log('Service Invoice totals — zero-rated and exempt portions')
const mixed = computeInvoiceTotals({ grossTotal: 100000, zeroRatedSales: 20000, vatExemptSales: 10000 })
check('only the vatable slice carries VAT', mixed.vat_amount,
  Number((70000 - 70000 / 1.12).toFixed(2)))
check('zero-rated passes through', mixed.zero_rated_sales, 20000)
check('exempt passes through',     mixed.vat_exempt_sales, 10000)

console.log('Service Invoice totals — guards')
check('zero gross is legal', computeInvoiceTotals({ grossTotal: 0 }).total_amount_due, 0)
throws('rejects a negative total',    () => computeInvoiceTotals({ grossTotal: -1 }))
throws('rejects a >100% discount',    () => computeInvoiceTotals({ grossTotal: 100, discountRate: 101 }))
throws('rejects exempt exceeding total', () => computeInvoiceTotals({ grossTotal: 100, vatExemptSales: 200 }))

console.log('Amount in words')
check('the worked example', amountInWords(67100), 'SIXTY-SEVEN THOUSAND ONE HUNDRED PESOS AND 00/100 ONLY')
check('centavos as a fraction', amountInWords(67100.5), 'SIXTY-SEVEN THOUSAND ONE HUNDRED PESOS AND 50/100 ONLY')
check('teens',      amountInWords(15), 'FIFTEEN PESOS AND 00/100 ONLY')
check('round tens', amountInWords(40), 'FORTY PESOS AND 00/100 ONLY')
check('hundreds',   amountInWords(105), 'ONE HUNDRED FIVE PESOS AND 00/100 ONLY')
check('zero',       amountInWords(0), 'ZERO PESOS AND 00/100 ONLY')
check('millions',   amountInWords(1234567.89),
  'ONE MILLION TWO HUNDRED THIRTY-FOUR THOUSAND FIVE HUNDRED SIXTY-SEVEN PESOS AND 89/100 ONLY')
check('rounds to centavos', amountInWords(0.005), 'ZERO PESOS AND 01/100 ONLY')
throws('rejects a negative amount', () => amountInWords(-1))

console.log('Formatting')
check('peso format', formatPeso(67100), '₱ 67,100.00')

console.log(`\n${'='.repeat(60)}`)
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  x ${f}\n`)
  process.exit(1)
}
console.log(`PASSED — all ${passed} checks green`)
