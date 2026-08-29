import PDFDocument from 'pdfkit'
import { cloudinary } from '../cloudinary.js'

/**
 * Shared furniture for 8338's two BIR-registered documents.
 *
 * Both are printed from the same booklet stock and carry the same company
 * header and Authority to Print footer, so those live here rather than being
 * duplicated and drifting apart.
 *
 * A word on what these PDFs are. The booklets are BIR-registered with
 * pre-printed serials; the physical pad is the authority. What is generated
 * here is the soft copy — it reproduces the layout and the serial the
 * accountant used, so the client has something to file and 8338 has something
 * to attach to an email. It is not a substitute for the paper.
 */

/** Everything on the pre-printed letterhead. */
export const COMPANY = {
  name: '8338 LOGISTICS SERVICES',
  vatReg: 'VAT Reg. TIN: 214-387-191-00000',
  address: 'Blk. 8 Lot 8 Lynville Enclave, Mamatid, City of Cabuyao, Laguna',
  proprietor: 'Victor S. Vargas – Prop.',
} as const

/**
 * The Authority to Print block printed at the foot of every BIR document.
 *
 * This is regulatory text, not decoration: a document without it is incomplete,
 * and one carrying the WRONG ATP number is worse than one carrying none — it
 * points an examiner at a different registered booklet.
 *
 * It is not defined here. Each pad has its own, and pads are replaced as they
 * run out, so the values live on the document_series row for that document type
 * where an accountant can update them when a new booklet arrives. Hardcoding
 * them once meant a code change and a redeploy every time 8338 bought paper.
 */
export interface AtpFooter {
  booklets: string
  authority: string
  atpDate: string
  printer: string
  printerAddress: string
  printerVat: string
  accreditation: string
  issued: string
  expiry: string
}

/** Shape of a document_series row, as far as the renderers care. */
export interface BookletSettings {
  atp_number: string | null
  atp_date: string | null
  booklet_label: string | null
  printer_name: string | null
  printer_address: string | null
  printer_vat: string | null
  printer_accreditation: string | null
  printer_issued: string | null
  printer_expiry: string | null
}

/**
 * Turn a booklet row into the footer as it should read.
 *
 * The stored values are the bare facts ('OCN 057AU…', '08-06-2025'); the
 * labels around them belong to the form, not to the data, so an accountant
 * typing a new ATP number never has to reproduce the wording.
 *
 * A missing value prints as an empty line rather than a placeholder. A footer
 * with a gap is visibly incomplete; one reading "N/A" or "undefined" looks
 * deliberate and could pass review unnoticed.
 */
export function atpFooterFrom(settings: BookletSettings | null | undefined): AtpFooter {
  const s = settings ?? ({} as BookletSettings)
  return {
    booklets: s.booklet_label ?? '',
    authority: s.atp_number ? `BIR Authority to Print No. ${s.atp_number}` : '',
    atpDate: s.atp_date ? `Date of ATP: ${s.atp_date}` : '',
    printer: s.printer_name ?? '',
    printerAddress: s.printer_address ?? '',
    printerVat: s.printer_vat ?? '',
    accreditation: s.printer_accreditation ?? '',
    issued: s.printer_issued ?? '',
    expiry: s.printer_expiry ?? '',
  }
}

export const PAGE = {
  size: 'A4' as const,
  margin: 40,
  get width() { return 595.28 - this.margin * 2 },
}

const RULE = '#000000'
const MUTED = '#444444'

export type Doc = InstanceType<typeof PDFDocument>

export function newDocument(): Doc {
  return new PDFDocument({ size: PAGE.size, margin: PAGE.margin })
}

/** `₱ 67,100.00` — the peso sign needs a font that has the glyph. */
export function peso(n: number): string {
  return `PHP ${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return ''
  return new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'long', day: '2-digit', timeZone: 'UTC',
  })
}

/** The company letterhead, plus the document title and its red serial. */
export function drawHeader(doc: Doc, title: string, serial: string): number {
  const { margin } = PAGE

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000')
     .text(COMPANY.name, margin, margin, { align: 'center', width: PAGE.width })
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
     .text(COMPANY.vatReg, { align: 'center', width: PAGE.width })
     .text(COMPANY.address, { align: 'center', width: PAGE.width })
     .text(COMPANY.proprietor, { align: 'center', width: PAGE.width })

  doc.moveDown(0.8)
  const titleY = doc.y

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000')
     .text(title, margin, titleY, { width: PAGE.width * 0.6 })

  // The serial is printed in red on the pad; matching that makes the soft copy
  // recognisable next to the paper.
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#c00000')
     .text(`No. ${serial}`, margin + PAGE.width * 0.6, titleY, {
       width: PAGE.width * 0.4, align: 'right',
     })

  doc.fillColor('#000')
  return titleY + 24
}

export function hr(doc: Doc, y: number, from = PAGE.margin, to = PAGE.margin + PAGE.width): void {
  doc.moveTo(from, y).lineTo(to, y).lineWidth(0.7).strokeColor(RULE).stroke()
}

/** A boxed label/value row, as the pre-printed form lays them out. */
export function labelled(doc: Doc, label: string, value: string, x: number, y: number, width: number): number {
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label, x, y)
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
     .text(value || '—', x, y + 10, { width, ellipsis: true })
  return y + 26
}

/**
 * The ATP block, pinned to the bottom of the page like the printed form.
 *
 * Takes the footer explicitly rather than defaulting to one, so a new document
 * type cannot silently inherit another booklet's registration.
 */
export function drawAtpFooter(doc: Doc, atp: AtpFooter): void {
  const y = 760
  hr(doc, y - 8)
  doc.font('Helvetica').fontSize(6).fillColor(MUTED)

  const left = [atp.booklets, atp.authority, atp.atpDate]
  const right = [
    atp.printer,
    atp.printerAddress,
    atp.printerVat,
    `${atp.accreditation}   ${atp.issued}   ${atp.expiry}`,
  ]

  left.forEach((line, i) => doc.text(line, PAGE.margin, y + i * 8, { width: PAGE.width * 0.45 }))
  right.forEach((line, i) =>
    doc.text(line, PAGE.margin + PAGE.width * 0.45, y + i * 8, { width: PAGE.width * 0.55 }))

  doc.fillColor('#000')
}

/** Signature rule with a caption, as printed. */
export function signatureLine(doc: Doc, caption: string, x: number, y: number, width: number): void {
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.7).strokeColor(RULE).stroke()
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(caption, x, y + 3, { width })
  doc.fillColor('#000')
}

/** Collect a finished document into a single Buffer. */
export function toBuffer(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}

/**
 * Store a rendered document and hand back its URL.
 *
 * `raw` rather than `auto`, because Cloudinary otherwise tries to treat a PDF
 * as an image and applies the account's PDF-delivery restrictions to it.
 */
export async function uploadPdf(buffer: Buffer, folder: string, publicId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: 'raw',
        format: 'pdf',
        overwrite: true,
        access_mode: 'public',
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'))
        resolve(result.secure_url)
      },
    )
    stream.end(buffer)
  })
}
