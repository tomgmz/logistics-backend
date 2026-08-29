import {
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
  type Doc,
} from './bir-document.js'
import type { AcknowledgementReceipt } from '../../types/billing.types.js'

/**
 * The Acknowledgement Receipt, matching 8338's BIR-registered booklet.
 *
 * Issued once a payment is confirmed; it is what closes a billing cycle. The
 * printed pad carries the disclaimer verbatim at the foot of the form, and it
 * is reproduced here because it is the line that distinguishes an AR from an
 * Official Receipt for tax purposes.
 */

const NOT_INPUT_TAX = '"THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX"'

const DESCRIPTION_ROWS = 6

function drawDescriptionTable(doc: Doc, receipt: AcknowledgementReceipt, startY: number): number {
  const descX = PAGE.margin
  const descW = PAGE.width - 150
  const amtX  = PAGE.margin + descW + 10
  const amtW  = 140

  let y = startY

  doc.font('Helvetica-Bold').fontSize(8)
  hr(doc, y - 4)
  doc.text('DESCRIPTION OF TRANSACTION / NATURE OF SERVICE', descX, y, { width: descW })
  doc.text('AMOUNT', amtX, y, { width: amtW, align: 'right' })
  y += 14
  hr(doc, y - 2)

  doc.font('Helvetica').fontSize(9)
  for (let i = 0; i < DESCRIPTION_ROWS; i++) {
    if (i === 0) {
      doc.text(receipt.description ?? '', descX, y, { width: descW, ellipsis: true })
      doc.text(peso(Number(receipt.total_paid_amount)), amtX, y, { width: amtW, align: 'right' })
    }
    y += 16
    hr(doc, y - 4)
  }

  doc.font('Helvetica-Bold').fontSize(10)
     .text('TOTAL PAID AMOUNT', descX, y + 4, { width: descW })
     .text(peso(Number(receipt.total_paid_amount)), amtX, y + 4, { width: amtW, align: 'right' })
  y += 22
  hr(doc, y)

  return y + 8
}

export interface ReceiptPdfInput {
  receipt: AcknowledgementReceipt
  /** The invoice this settles, printed as the reference. */
  siNumber: string
}

export async function renderAcknowledgementReceipt({
  receipt,
  siNumber,
}: ReceiptPdfInput): Promise<Buffer> {
  const doc = newDocument()

  let y = drawHeader(doc, 'ACKNOWLEDGEMENT RECEIPT', receipt.ar_number)

  doc.font('Helvetica-Bold').fontSize(9)
     .text(`Payment Date: ${fmtDate(receipt.receipt_date)}`, PAGE.margin, y, { width: PAGE.width * 0.5 })
     .text(`Account No.: ${receipt.account_no ?? '—'}`, PAGE.margin + PAGE.width * 0.5, y,
           { width: PAGE.width * 0.5, align: 'right' })
  y += 20
  hr(doc, y)
  y += 8

  doc.font('Helvetica-Bold').fontSize(9).text('RECEIVED FROM:', PAGE.margin, y)
  const cash = receipt.payment_method === 'cash'
  doc.font('Helvetica').fontSize(8)
     .text(`[${cash ? 'X' : ' '}]  CASH        [${cash ? ' ' : 'X'}]  CHECK`,
           PAGE.margin + 120, y + 1)
  y += 16

  y = labelled(doc, 'Registered Name', receipt.received_from_name, PAGE.margin, y, PAGE.width)
  y = labelled(doc, 'Business Address', receipt.business_address ?? '', PAGE.margin, y, PAGE.width)
  y = labelled(doc, 'TIN', receipt.tin ?? '', PAGE.margin, y, PAGE.width * 0.4)

  y = labelled(doc, 'Invoice Reference No.', siNumber, PAGE.margin, y, PAGE.width * 0.5)
  y = labelled(doc, 'Payment for', receipt.payment_for ?? '', PAGE.margin, y, PAGE.width)

  y = drawDescriptionTable(doc, receipt, y + 6)

  // Spelled out on the printed form, so a figure cannot be altered after issue.
  doc.font('Helvetica').fontSize(8).text('Amount in words:', PAGE.margin, y)
  doc.font('Helvetica-Bold').fontSize(9)
     .text(receipt.amount_in_words ?? '', PAGE.margin, y + 11, { width: PAGE.width })
  y += 32
  hr(doc, y)

  signatureLine(doc, 'CASHIER / AUTHORIZED REPRESENTATIVE', PAGE.margin + PAGE.width - 240, 700, 240)

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
     .text(NOT_INPUT_TAX, PAGE.margin, 735, { width: PAGE.width, align: 'center' })

  drawAtpFooter(doc)

  return toBuffer(doc)
}

/** Render and store, returning the URL to put on the receipt row. */
export async function publishAcknowledgementReceipt(input: ReceiptPdfInput): Promise<string> {
  const buffer = await renderAcknowledgementReceipt(input)
  return uploadPdf(buffer, 'billing_documents/receipts', `AR-${input.receipt.ar_number}`)
}
