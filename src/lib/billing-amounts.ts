/**
 * Service Invoice arithmetic.
 *
 * Kept pure and separate from the workflow so the numbers printed on a
 * BIR document can be checked without a database.
 *
 * 8338 is VAT-registered (TIN 214-387-191-00000), and the printed form's
 * right-hand column reads top to bottom:
 *
 *     Total Sales (VAT Inclusive)
 *     Less: VAT 12%
 *     Amount: Net of VAT
 *     Less: Discount
 *     Add: VAT
 *     Less: Withholding Tax
 *     TOTAL AMOUNT DUE
 *
 * So line amounts are entered VAT-INCLUSIVE, the VAT is stripped back out to
 * reach a net figure, any discount comes off that net, VAT is re-applied to the
 * discounted net, and creditable withholding tax is deducted last. Withholding
 * is computed on the net of VAT, not the gross — that is how EWT works, and
 * getting it backwards overstates the deduction by 12%.
 */

export const VAT_RATE = 0.12

/** Rounds to centavos. Money must never carry binary float noise onto a form. */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export interface InvoiceTotalsInput {
  /** Sum of the period's line amounts, VAT inclusive. */
  grossTotal: number
  /** Percentage off the net of VAT, e.g. 5 for 5%. Defaults to none. */
  discountRate?: number
  /**
   * Creditable withholding tax percentage the client will deduct, e.g. 2.
   *
   * Deliberately defaults to 0 rather than the common 2% for services: the rate
   * depends on the client's own tax status, and quietly guessing it would put a
   * wrong TOTAL AMOUNT DUE on a BIR document.
   */
  withholdingTaxRate?: number
  /** Portions of the gross that are not vatable, if any. */
  zeroRatedSales?: number
  vatExemptSales?: number
}

export interface InvoiceTotals {
  vatable_sales: number
  vat_amount: number
  zero_rated_sales: number
  vat_exempt_sales: number
  total_sales_vat_inclusive: number
  net_of_vat: number
  discount_rate: number
  discount_amount: number
  withholding_tax_rate: number
  withholding_tax_amount: number
  total_amount_due: number
}

export function computeInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  const gross          = money(input.grossTotal)
  const zeroRated      = money(input.zeroRatedSales ?? 0)
  const vatExempt      = money(input.vatExemptSales ?? 0)
  const discountRate   = input.discountRate ?? 0
  const withholdingPct = input.withholdingTaxRate ?? 0

  if (gross < 0) throw new Error('billing-amounts: gross total cannot be negative')
  if (discountRate < 0 || discountRate > 100) throw new Error('billing-amounts: discount rate must be 0-100')
  if (withholdingPct < 0 || withholdingPct > 100) throw new Error('billing-amounts: withholding rate must be 0-100')
  if (zeroRated + vatExempt > gross) {
    throw new Error('billing-amounts: zero-rated and exempt sales exceed the total')
  }

  // Only the vatable slice carries VAT; the rest passes through untouched.
  const vatableGross = money(gross - zeroRated - vatExempt)
  const vatableNet   = money(vatableGross / (1 + VAT_RATE))
  const vatAmount    = money(vatableGross - vatableNet)

  const netOfVat = money(vatableNet + zeroRated + vatExempt)

  const discountAmount = money(netOfVat * (discountRate / 100))
  const discountedNet  = money(netOfVat - discountAmount)

  // VAT is re-applied to whatever is left of the vatable portion after discount.
  const discountedVatableNet = money(vatableNet - money(vatableNet * (discountRate / 100)))
  const vatToAdd = money(discountedVatableNet * VAT_RATE)

  // Creditable withholding is taken against the net, never the VAT.
  const withholdingAmount = money(discountedNet * (withholdingPct / 100))

  const totalDue = money(discountedNet + vatToAdd - withholdingAmount)

  return {
    vatable_sales: vatableNet,
    vat_amount: vatAmount,
    zero_rated_sales: zeroRated,
    vat_exempt_sales: vatExempt,
    total_sales_vat_inclusive: gross,
    net_of_vat: netOfVat,
    discount_rate: discountRate,
    discount_amount: discountAmount,
    withholding_tax_rate: withholdingPct,
    withholding_tax_amount: withholdingAmount,
    total_amount_due: totalDue,
  }
}

// ---------------------------------------------------------------------------

const ONES = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
]
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']
const SCALES: [number, string][] = [
  [1_000_000_000, 'BILLION'],
  [1_000_000, 'MILLION'],
  [1_000, 'THOUSAND'],
]

function underThousand(n: number): string {
  if (n === 0) return ''
  if (n < 20) return ONES[n]
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]
    const o = ONES[n % 10]
    return o ? `${t}-${o}` : t
  }
  const h = `${ONES[Math.floor(n / 100)]} HUNDRED`
  const rest = underThousand(n % 100)
  return rest ? `${h} ${rest}` : h
}

function whole(n: number): string {
  if (n === 0) return 'ZERO'
  let out = ''
  let left = n
  for (const [value, name] of SCALES) {
    if (left >= value) {
      out += `${out ? ' ' : ''}${underThousand(Math.floor(left / value))} ${name}`
      left %= value
    }
  }
  if (left > 0) out += `${out ? ' ' : ''}${underThousand(left)}`
  return out
}

/**
 * The "Amount in words" line on the Acknowledgement Receipt.
 *
 * Philippine receipts spell the centavos as a fraction rather than in words,
 * e.g. 67,100.50 -> "SIXTY-SEVEN THOUSAND ONE HUNDRED PESOS AND 50/100 ONLY".
 */
export function amountInWords(amount: number): string {
  if (amount < 0) throw new Error('billing-amounts: cannot spell a negative amount')
  const cents = Math.round(amount * 100)
  const pesos = Math.floor(cents / 100)
  const centavos = cents % 100
  return `${whole(pesos)} PESOS AND ${String(centavos).padStart(2, '0')}/100 ONLY`
}

/** `₱ 67,100.00`, for screens and PDFs. */
export function formatPeso(amount: number): string {
  return `₱ ${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
