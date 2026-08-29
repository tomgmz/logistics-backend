/**
 * Renders a sample Service Invoice and Acknowledgement Receipt to disk so the
 * layout can be checked against the photographed BIR booklets.
 *
 *   npx tsx scripts/preview-billing-pdfs.ts [outDir]
 *
 * Renders only — nothing is uploaded and nothing touches the database.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { renderServiceInvoice } from '../src/lib/pdf/service-invoice.pdf.js'
import { renderAcknowledgementReceipt } from '../src/lib/pdf/acknowledgement-receipt.pdf.js'
import { amountInWords, computeInvoiceTotals } from '../src/lib/billing-amounts.js'

const outDir = process.argv[2] ?? '.'

// The worked example from the contract discussion: a booking billed at 18,500
// with a second surcharge line, under 2% creditable withholding.
const gross = 18_500 + 1_500
const totals = computeInvoiceTotals({ grossTotal: gross, withholdingTaxRate: 2 })

const invoice = {
  invoice_id: 'preview',
  period_id: 'preview',
  booking_id: 'preview',
  si_number: '151',
  invoice_date: '2026-03-30',
  sale_type: 'charge' as const,
  sold_to_name: 'AIRSPEED CORPORATION',
  sold_to_tin: '004-521-778-00000',
  sold_to_address: '2310 Chino Roces Ave Ext, Makati City, Metro Manila',
  ...totals,
  payment_terms_days: 45 as const,
  term_end_date: '2026-05-14',
  due_date: '2026-05-15',
  payment_status: 'unpaid' as const,
  overdue_notified_at: null,
  pdf_url: null,
  issued_by: null,
  issued_at: '2026-03-30T00:00:00Z',
  created_at: '2026-03-30T00:00:00Z',
  updated_at: '2026-03-30T00:00:00Z',
}

const items = [
  {
    item_id: '1', period_id: 'preview', booking_id: 'preview',
    description: 'Freight and logistics services — BK-2026-0041',
    quantity: 1, unit_price: 18_500, amount: 18_500, sort_order: 0,
    created_at: '', updated_at: '',
  },
  {
    item_id: '2', period_id: 'preview', booking_id: 'preview',
    description: 'Fuel surcharge',
    quantity: 1, unit_price: 1_500, amount: 1_500, sort_order: 1,
    created_at: '', updated_at: '',
  },
]

const receipt = {
  ar_id: 'preview',
  payment_id: 'preview',
  invoice_id: 'preview',
  ar_number: '0015',
  receipt_date: '2026-05-15',
  account_no: 'BDO 0012-3456-7890',
  received_from_name: 'AIRSPEED CORPORATION',
  business_address: '2310 Chino Roces Ave Ext, Makati City, Metro Manila',
  tin: '004-521-778-00000',
  payment_method: 'check' as const,
  payment_for: 'Service Invoice 151',
  description: 'Freight and logistics services, Mar 16–31, 2026',
  total_paid_amount: totals.total_amount_due,
  amount_in_words: amountInWords(totals.total_amount_due),
  pdf_url: null,
  issued_by: null,
  issued_at: '2026-05-15T00:00:00Z',
  created_at: '2026-05-15T00:00:00Z',
}

const si = await renderServiceInvoice({ invoice, items, bookingRef: 'BK-2026-0041' })
writeFileSync(path.join(outDir, 'preview-service-invoice.pdf'), si)

const ar = await renderAcknowledgementReceipt({ receipt, siNumber: '151' })
writeFileSync(path.join(outDir, 'preview-acknowledgement-receipt.pdf'), ar)

console.log(`Service Invoice        ${si.length.toLocaleString()} bytes`)
console.log(`Acknowledgement Receipt ${ar.length.toLocaleString()} bytes`)
console.log(`\ntotals used:`)
console.log(`  gross (VAT inclusive) ${totals.total_sales_vat_inclusive}`)
console.log(`  net of VAT            ${totals.net_of_vat}`)
console.log(`  VAT 12%               ${totals.vat_amount}`)
console.log(`  withholding 2%        ${totals.withholding_tax_amount}`)
console.log(`  TOTAL AMOUNT DUE      ${totals.total_amount_due}`)
console.log(`  in words              ${receipt.amount_in_words}`)
console.log(`\nwritten to ${path.resolve(outDir)}`)
