import {
  atpFooterFrom,
  drawAtpFooter,
  drawHeader,
  fmtDate,
  hr,
  labelled,
  newDocument,
  PAGE,
  peso,
  signatureLine,
  toBuffer,
  uploadPdf,
  type BookletSettings,
  type Doc,
} from './bir-document.js'
import type { ServiceInvoice, BillingPeriodItem } from '../../types/billing.types.js'

/**
 * The Service Invoice, laid out to match 8338's BIR-registered booklet.
 *
 * The totals column follows the printed form exactly, top to bottom:
 *
 *     Total Sales (VAT Inclusive)
 *     Less: VAT 12%
 *     Amount: Net of VAT
 *     Less: Discount
 *     Add: VAT
 *     Less: Withholding Tax
 *     TOTAL AMOUNT DUE
 *
 * The order matters as much as the arithmetic — this is the sequence a BIR
 * examiner reads, and the figures come pre-rounded from computeInvoiceTotals()
 * so the printed lines reconcile to the printed total.
 */

const ITEM_ROWS = 12

interface Column { label: string; x: number; width: number; align?: 'left' | 'right' }

const COLUMNS: Column[] = [
  { label: 'Item Description / Nature of Service', x: PAGE.margin,       width: 250 },
  { label: 'Quantity',                             x: PAGE.margin + 252, width: 60, align: 'right' },
  { label: 'Unit Cost / Price',                    x: PAGE.margin + 314, width: 90, align: 'right' },
  { label: 'Amount',                               x: PAGE.margin + 406, width: 109, align: 'right' },
]

function drawItemTable(doc: Doc, items: BillingPeriodItem[], startY: number): number {
  let y = startY

  doc.font('Helvetica-Bold').fontSize(8)
  hr(doc, y - 4)
  for (const c of COLUMNS) {
    doc.text(c.label, c.x, y, { width: c.width, align: c.align ?? 'left' })
  }
  y += 14
  hr(doc, y - 2)

  doc.font('Helvetica').fontSize(9)

  // The pad has a fixed number of ruled lines; keeping them makes the soft copy
  // sit alongside the paper rather than looking like a different document.
  for (let i = 0; i < ITEM_ROWS; i++) {
    const item = items[i]
    if (item) {
      doc.text(item.description, COLUMNS[0].x, y, { width: COLUMNS[0].width, ellipsis: true })
      doc.text(String(Number(item.quantity)), COLUMNS[1].x, y, { width: COLUMNS[1].width, align: 'right' })
      doc.text(peso(Number(item.unit_price)), COLUMNS[2].x, y, { width: COLUMNS[2].width, align: 'right' })
      doc.text(peso(Number(item.amount)), COLUMNS[3].x, y, { width: COLUMNS[3].width, align: 'right' })
    }
    y += 16
    hr(doc, y - 4)
  }

  // An invoice that overflows the ruled lines would silently drop charges.
  if (items.length > ITEM_ROWS) {
    doc.font('Helvetica-Oblique').fontSize(7)
       .text(`+ ${items.length - ITEM_ROWS} further line(s) — see attached schedule`,
             COLUMNS[0].x, y, { width: PAGE.width })
    y += 12
  }

  return y
}

function drawTotals(doc: Doc, invoice: ServiceInvoice, startY: number): number {
  const leftX = PAGE.margin
  const leftW = 250
  const rightX = PAGE.margin + 262
  const rightW = PAGE.width - 262

  // Left block: the VAT breakdown of sales.
  let ly = startY + 6
  doc.font('Helvetica').fontSize(8)
  const leftRows: [string, number][] = [
    ['VATable Sales', Number(invoice.vatable_sales)],
    ['VAT 12%', Number(invoice.vat_amount)],
    ['Zero Rated Sales', Number(invoice.zero_rated_sales)],
    ['VAT-Exempt Sales', Number(invoice.vat_exempt_sales)],
  ]
  for (const [label, value] of leftRows) {
    doc.text(label, leftX + 4, ly, { width: leftW * 0.55 })
    doc.text(peso(value), leftX + leftW * 0.55, ly, { width: leftW * 0.45 - 4, align: 'right' })
    ly += 14
    hr(doc, ly - 3, leftX, leftX + leftW)
  }

  // Right block: the running computation down to what is actually owed.
  let ry = startY + 6
  const rightRows: [string, number, boolean?][] = [
    ['Total Sales (VAT Inclusive)', Number(invoice.total_sales_vat_inclusive)],
    ['Less: VAT 12%', Number(invoice.vat_amount)],
    ['Amount: Net of VAT', Number(invoice.net_of_vat)],
    [`Less: Discount ${invoice.discount_rate ? `(${invoice.discount_rate}%)` : ''}`.trim(), Number(invoice.discount_amount)],
    ['Add: VAT', Number(invoice.vat_amount)],
    [`Less: Withholding Tax ${invoice.withholding_tax_rate ? `(${invoice.withholding_tax_rate}%)` : ''}`.trim(),
      Number(invoice.withholding_tax_amount)],
  ]
  for (const [label, value] of rightRows) {
    doc.font('Helvetica').fontSize(8)
       .text(label, rightX + 4, ry, { width: rightW * 0.6 })
       .text(peso(value), rightX + rightW * 0.6, ry, { width: rightW * 0.4 - 4, align: 'right' })
    ry += 14
    hr(doc, ry - 3, rightX, rightX + rightW)
  }

  doc.font('Helvetica-Bold').fontSize(10)
     .text('TOTAL AMOUNT DUE', rightX + 4, ry + 3, { width: rightW * 0.6 })
     .text(peso(Number(invoice.total_amount_due)), rightX + rightW * 0.6, ry + 3,
           { width: rightW * 0.4 - 4, align: 'right' })
  ry += 20
  hr(doc, ry, rightX, rightX + rightW)

  return Math.max(ly, ry) + 10
}

export interface ServiceInvoicePdfInput {
  invoice: ServiceInvoice
  items: BillingPeriodItem[]
  /** Booking reference, printed so the invoice ties back to one delivery. */
  bookingRef?: string | null
  /**
   * The pad this was written on, from document_series. Required in practice —
   * an invoice rendered without it has no Authority to Print block, which the
   * caller passes rather than the renderer fetching, so the PDF layer stays
   * free of database access.
   */
  booklet?: BookletSettings | null
}

export async function renderServiceInvoice({
  invoice,
  items,
  bookingRef,
  booklet,
}: ServiceInvoicePdfInput): Promise<Buffer> {
  const doc = newDocument()

  let y = drawHeader(doc, 'SERVICE INVOICE', invoice.si_number)

  // Sale type checkboxes, as on the form.
  doc.font('Helvetica').fontSize(8)
  const cash = invoice.sale_type === 'cash'
  doc.text(`[${cash ? 'X' : ' '}]  CASH SALES`, PAGE.margin, y)
  doc.text(`[${cash ? ' ' : 'X'}]  CHARGE SALES`, PAGE.margin, y + 12)
  doc.font('Helvetica-Bold').fontSize(9)
     .text(`Date: ${fmtDate(invoice.invoice_date)}`, PAGE.margin + 300, y, {
       width: PAGE.width - 300, align: 'right',
     })
  y += 32
  hr(doc, y)
  y += 8

  doc.font('Helvetica-Bold').fontSize(9).text('SOLD TO:', PAGE.margin, y)
  y += 14
  y = labelled(doc, 'Registered Name', invoice.sold_to_name, PAGE.margin, y, PAGE.width)
  y = labelled(doc, 'TIN', invoice.sold_to_tin ?? '', PAGE.margin, y, PAGE.width * 0.4)
  y = labelled(doc, 'Business Address', invoice.sold_to_address ?? '', PAGE.margin, y, PAGE.width)

  if (bookingRef) {
    doc.font('Helvetica').fontSize(8).fillColor('#444')
       .text(`Covering booking ${bookingRef}`, PAGE.margin, y)
       .fillColor('#000')
    y += 14
  }

  y = drawItemTable(doc, items, y + 6)
  y = drawTotals(doc, invoice, y)

  // Payment terms are not on the pre-printed pad, but an invoice that does not
  // say when it is due is useless to whoever has to pay it.
  doc.font('Helvetica').fontSize(8).fillColor('#444')
     .text(
       `Payment terms: ${invoice.payment_terms_days} days from issuance. ` +
       `Due ${fmtDate(invoice.due_date)}. 8338 accepts payment on Fridays only.`,
       PAGE.margin, y + 4, { width: PAGE.width },
     )
     .fillColor('#000')

  signatureLine(doc, 'Cashier / Authorized Representative', PAGE.margin, 720, 220)
  signatureLine(doc, 'SC/PWD/NAAC/MOV/Solo Parent — Signature', PAGE.margin + 280, 720, 220)

  drawAtpFooter(doc, atpFooterFrom(booklet))

  return toBuffer(doc)
}

/** Render and store, returning the URL to put on the invoice row. */
export async function publishServiceInvoice(input: ServiceInvoicePdfInput): Promise<string> {
  const buffer = await renderServiceInvoice(input)
  return uploadPdf(buffer, 'billing_documents/service_invoices', `SI-${input.invoice.si_number}`)
}
