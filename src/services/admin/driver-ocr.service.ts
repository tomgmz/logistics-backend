import axios from 'axios'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

/**
 * Reading a driver's license photo.
 *
 * ID Analyzer (api2.idanalyzer.com/scan) is the only scanner: it is asked for a
 * Philippine driver's license only (restrictCountry PH, restrictType D), so it
 * says when the photo is something else, and it flags fake or edited cards.
 *
 * Google Vision was the text-only fallback until 2026-11-18 (removed at the
 * user's request). When ID Analyzer is down, out of credits or not configured,
 * extractLicenseData throws: the form says the scan failed, the number and
 * expiry may then be typed, and the save needs a note (scanFailed in the
 * driver controller).
 */

const IDANALYZER_API_KEY = process.env.IDANALYZER_API_KEY
// A KYC profile id from the ID Analyzer portal (set one with image storage off),
// else a preset. https://api2-eu.idanalyzer.com for the EU region.
const IDANALYZER_PROFILE  = process.env.IDANALYZER_PROFILE || 'security_medium'
const IDANALYZER_ENDPOINT = (process.env.IDANALYZER_ENDPOINT || 'https://api2.idanalyzer.com').replace(/\/+$/, '')

export interface LicenseWarning { code: string; description: string }

export interface VehicleEligibility {
  can_drive_light_commercial: boolean
  can_drive_heavy_truck: boolean
  can_drive_articulated: boolean
  can_drive_bus: boolean
}

export interface LicenseOCRResult {
  license_number:  string | null
  license_expiry:  string | null
  first_name:      string | null
  last_name:       string | null
  middle_name:     string | null
  suffix:          string | null
  dl_codes:        string[]
  restriction_codes: string[]
  vehicle_eligibility: VehicleEligibility
  /** False when the photo is not a Philippine driver's license; the save is refused. */
  is_license:      boolean
  /** Why it isn't one, in words for the form. */
  not_license_reason: string | null
  /** Fake / edited card flags from ID Analyzer; saving then needs a note. */
  fraud_warnings:  LicenseWarning[]
  provider:        'idanalyzer'
}

const VALID_SUFFIXES   = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V']
const NAME_LABEL_RE    = /^(name|holder)[:\s]+/i
const DL_CODE_RE       = /\b(CE|BE|A1|B1|B2|[ABCD])\b/g
const OLD_RESTRICT_RE  = /\b([1-8])\b/g
const DL_SECTION_RE    = /dl\s*code|vehicle\s*categor|condition\s*code|restriction/i

// Words that start a compound surname (DELA CRUZ, DE LA CRUZ, DE LOS SANTOS,
// STA. MARIA). Compared without dots, so "STA." and "VDA." count.
const COMPOUND_PREFIXES = new Set([
  'DE', 'DEL', 'DELA', 'DELOS', 'DELAS', 'DI', 'LA', 'LOS', 'LAS',
  'SAN', 'SANTA', 'SANTO', 'STO', 'STA',
  'VDA', 'MAC', 'MC',
])
const isPrefix = (w: string) => COMPOUND_PREFIXES.has(w.replace(/\./g, '').toUpperCase())

/**
 * "2030/05/12", "2030-5-12", "05/12/2030" (or with dots or spaces) → "2030-05-12".
 * A day that doesn't exist (2030-02-30, 2030-13-01) is null rather than a date
 * JavaScript quietly rolls into the next month: the expiry is locked once read,
 * so a wrong one must never get in.
 */
function toISODate(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.replace(/\s+/g, '')
  let y: number, m: number, d: number
  let match = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?!\d)/)
  if (match) { y = +match[1]; m = +match[2]; d = +match[3] }
  else {
    match = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?!\d)/)
    if (!match) return null
    y = +match[3]; m = +match[1]; d = +match[2]
  }
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * An expiry a real license could have: not before 2000 and at most LTO's
 * 10-year validity (plus the birthday slack) from today. Anything else is a
 * misread and comes back null, so the form asks for a clearer photo instead of
 * locking a wrong date in.
 */
function plausibleExpiry(iso: string | null): string | null {
  if (!iso) return null
  const max = new Date(Date.now() + (10 * 366 + 31) * 86_400_000).toISOString().slice(0, 10)
  return iso >= '2000-01-01' && iso <= max ? iso : null
}

function toTitleCase(str: string | null): string | null {
  if (!str) return null
  return str.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').trim() || null
}

function extractSuffix(name: string): { cleaned: string; suffix: string | null } {
  for (const s of VALID_SUFFIXES) {
    // A whole word, dot optional ("JR" / "JR."); \b can't follow a dot, so the
    // end is a space, comma or the end of the line.
    const re = new RegExp(`(^|[\\s,])${s.replace('.', '\\.?')}(?=[\\s,]|$)`, 'i')
    if (re.test(name)) {
      return { cleaned: name.replace(re, '$1').replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim(), suffix: s }
    }
  }
  return { cleaned: name, suffix: null }
}

/**
 * Split given names into first and middle. A Filipino middle name is the
 * mother's maiden surname: one word, or a compound one (DELA CRUZ, DE LOS
 * SANTOS). Everything before it is the first name, so "TOM ERVIN REYES" is
 * first "Tom Ervin", middle "Reyes", not first "Tom", middle "Ervin Reyes".
 */
function splitGivenNames(words: string[]): { first: string[]; middle: string[] } {
  if (words.length <= 1) return { first: words, middle: [] }
  let middleStart = words.length - 1
  while (middleStart > 1 && isPrefix(words[middleStart - 1])) middleStart--
  return { first: words.slice(0, middleStart), middle: words.slice(middleStart) }
}

/** Where a (possibly compound) surname starts at the end of `words`. */
function surnameStart(words: string[]): number {
  let i = words.length - 1
  while (i > 1 && isPrefix(words[i - 1])) i--
  return i
}

function parseName(
  line: string,
): Pick<LicenseOCRResult, 'first_name' | 'last_name' | 'middle_name' | 'suffix'> {
  const cleaned = line.replace(NAME_LABEL_RE, '').trim()
  const { cleaned: withoutSuffix, suffix } = extractSuffix(cleaned)

  // The PH card prints "LAST, FIRST [MORE FIRST] MIDDLE".
  if (withoutSuffix.includes(',')) {
    const [lastRaw, restRaw] = withoutSuffix.split(',', 2)
    const { first, middle } = splitGivenNames(restRaw.trim().split(/\s+/).filter(Boolean))
    return {
      last_name:   toTitleCase(lastRaw.trim()),
      first_name:  toTitleCase(first.join(' ') || null),
      middle_name: toTitleCase(middle.join(' ') || null),
      suffix,
    }
  }

  // No comma: "FIRST [MORE FIRST] MIDDLE LAST". The surname and the middle name
  // are one (possibly compound) surname each; every other word is the first name.
  const parts = withoutSuffix.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return { first_name: toTitleCase(parts[0]), last_name: null, middle_name: null, suffix }
  const lastAt = surnameStart(parts)
  const { first, middle } = splitGivenNames(parts.slice(0, lastAt))
  return {
    first_name:  toTitleCase(first.join(' ')),
    middle_name: toTitleCase(middle.join(' ') || null),
    last_name:   toTitleCase(parts.slice(lastAt).join(' ')),
    suffix,
  }
}

function extractDLCodes(lines: string[]): { dl_codes: string[]; restriction_codes: string[] } {
  const dlCodes   = new Set<string>()
  const restrCode = new Set<string>()

  let inDLSection = false
  for (const line of lines) {
    if (DL_SECTION_RE.test(line)) { inDLSection = true; continue }

    if (inDLSection) {
      for (const m of line.matchAll(DL_CODE_RE)) dlCodes.add(m[1].toUpperCase())
      for (const m of line.matchAll(OLD_RESTRICT_RE)) restrCode.add(m[1])
    }
  }

  if (dlCodes.size === 0) {
    const fullText = lines.join(' ')
    for (const m of fullText.matchAll(DL_CODE_RE)) dlCodes.add(m[1].toUpperCase())
    // Only grab old restriction codes if no new DL codes found
    if (dlCodes.size === 0) {
      for (const m of fullText.matchAll(OLD_RESTRICT_RE)) restrCode.add(m[1])
    }
  }

  return {
    dl_codes:          [...dlCodes],
    restriction_codes: [...restrCode],
  }
}

function deriveEligibility(dl_codes: string[], restriction_codes: string[]): VehicleEligibility {
  const dl   = new Set(dl_codes.map(c => c.toUpperCase()))
  const rc   = new Set(restriction_codes)

  return {
    can_drive_light_commercial:
      dl.has('B2') || rc.has('2'),

    can_drive_heavy_truck:
      dl.has('C') || rc.has('3'),

    can_drive_articulated:
      dl.has('CE') || rc.has('5') || rc.has('6'),

    can_drive_bus:
      dl.has('D'),
  }
}

const NOT_LICENSE_MESSAGE =
  "This photo doesn't look like a Philippine driver's license. Take a clear photo of the front of the card, flat and without glare."

// ── ID Analyzer ─────────────────────────────────────────────────────────────

// Warnings that mean the photo is not a Philippine driver's license. The real
// API answered a logo with UNRECOGNIZED_DOCUMENT + COUNTRY_NOT_ACCEPTED +
// TYPE_NOT_ACCEPTED (2026-11-16); the MISMATCH names are from the docs.
const NOT_LICENSE_CODES = new Set([
  'UNRECOGNIZED_DOCUMENT', 'COUNTRY_NOT_ACCEPTED', 'TYPE_NOT_ACCEPTED',
  'DOCUMENT_COUNTRY_MISMATCH', 'DOCUMENT_TYPE_MISMATCH',
])
// Warnings that mean the card may be fake or edited: a person decides (note).
const FRAUD_CODE_RE = /FAKE|FORGERY|EDITED|ARTIFICIAL|SCREEN|PHOTOCOPY|PRINTED|TAMPER/

/** First value of a field: ID Analyzer sends each as [{ value, confidence, … }]. */
function idaField(data: any, key: string): string | null {
  const raw   = data?.[key]
  const first = Array.isArray(raw) ? raw[0] : raw
  const value = first && typeof first === 'object' ? first.value : first
  return value == null || String(value).trim() === '' ? null : String(value).trim()
}

/** "A01-23-456789" from any spacing or dashes; anything else as read. */
function formatLtoNumber(raw: string | null): string | null {
  if (!raw) return null
  const bare = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-Z]\d{10}$/.test(bare) ? `${bare.slice(0, 3)}-${bare.slice(3, 5)}-${bare.slice(5)}` : raw.toUpperCase()
}

/**
 * The expiry ID Analyzer read, only when it can be a real one: a valid date, in
 * the plausible range, and after the birth date and issue date (a read that
 * came back with one of those is not an expiry).
 */
function idaExpiry(data: any): string | null {
  const expiry = plausibleExpiry(toISODate(idaField(data, 'expiry')))
  if (!expiry) return null
  const born   = toISODate(idaField(data, 'dob'))
  const issued = toISODate(idaField(data, 'issued'))
  if ((born && expiry <= born) || (issued && expiry <= issued)) return null
  return expiry
}

class ProviderError extends Error {}

async function idAnalyzerScan(compressed: Buffer): Promise<LicenseOCRResult> {
  let body: any
  try {
    const res = await axios.post(
      `${IDANALYZER_ENDPOINT}/scan`,
      {
        document:        compressed.toString('base64'),
        profile:         IDANALYZER_PROFILE,
        restrictCountry: 'PH',
        restrictType:    'D',
      },
      {
        headers: { 'X-API-KEY': IDANALYZER_API_KEY!, Accept: 'application/json', 'Content-Type': 'application/json' },
        timeout: 30_000,
        maxBodyLength: 20 * 1024 * 1024,
      },
    )
    body = res.data
  } catch (err: any) {
    const msg = err.response?.data?.error?.message ?? err.response?.data?.message ?? err.message ?? String(err)
    throw new ProviderError(`ID Analyzer error: ${msg}`)
  }
  if (!body || body.error || body.success === false) {
    throw new ProviderError(`ID Analyzer error: ${body?.error?.message ?? body?.error ?? 'no result'}`)
  }

  const data     = body.data ?? {}
  const warnings: LicenseWarning[] = (Array.isArray(body.warning) ? body.warning : [])
    .map((w: any) => ({ code: String(w?.code ?? ''), description: String(w?.description ?? w?.code ?? '') }))
    .filter((w: LicenseWarning) => w.code)

  const docType  = idaField(data, 'documentType')
  const country  = idaField(data, 'countryIso2')
  const number   = idaField(data, 'documentNumber')

  let notLicense: string | null = null
  if (warnings.some((w) => NOT_LICENSE_CODES.has(w.code))) notLicense = NOT_LICENSE_MESSAGE
  else if (docType && docType.toUpperCase() !== 'D') notLicense = `${NOT_LICENSE_MESSAGE} It reads as a ${docType.toUpperCase() === 'P' ? 'passport' : 'different ID'}.`
  else if (country && country.toUpperCase() !== 'PH') notLicense = `${NOT_LICENSE_MESSAGE} It reads as a card from another country (${country.toUpperCase()}).`
  else if (!docType && !number) notLicense = NOT_LICENSE_MESSAGE

  // The PH card prints "LAST, FIRST MIDDLE"; our parser knows its compound
  // surnames (DELA CRUZ), so it is used whenever the full line came back.
  const fullName = idaField(data, 'fullName')
  let name: Pick<LicenseOCRResult, 'first_name' | 'last_name' | 'middle_name' | 'suffix'>
  if (fullName && fullName.includes(',')) {
    name = parseName(fullName)
  } else {
    const first      = idaField(data, 'firstName')
    const middleRead = idaField(data, 'middleName')
    const { cleaned, suffix } = extractSuffix(first ?? '')
    // ID Analyzer splits the given names on its own guess and has sent
    // first "TOM", middle "ERVIN REYES" for TOM ERVIN REYES: re-split them the
    // Filipino way (the middle name is the mother's one surname).
    const given = [...cleaned.split(/\s+/), ...(middleRead ?? '').split(/\s+/)].filter(Boolean)
    const { first: firstWords, middle } = middleRead
      ? splitGivenNames(given)
      : { first: given, middle: [] as string[] }
    name = {
      first_name:  toTitleCase(firstWords.join(' ') || null),
      middle_name: toTitleCase(middle.join(' ') || null),
      last_name:   toTitleCase(idaField(data, 'lastName')),
      suffix,
    }
    if (!name.first_name && !name.last_name && fullName) name = parseName(fullName)
  }

  // DL codes, when ID Analyzer returns them (vehicle class / restrictions).
  const classText = [idaField(data, 'vehicleClass'), idaField(data, 'restrictions')].filter(Boolean).join(' ')
  const { dl_codes, restriction_codes } = classText
    ? extractDLCodes(['DL Codes', classText])
    : { dl_codes: [] as string[], restriction_codes: [] as string[] }

  return {
    license_number:  formatLtoNumber(number),
    license_expiry:  idaExpiry(data),
    ...name,
    dl_codes,
    restriction_codes,
    vehicle_eligibility: deriveEligibility(dl_codes, restriction_codes),
    is_license:         notLicense === null,
    not_license_reason: notLicense,
    fraud_warnings:     warnings.filter((w) => FRAUD_CODE_RE.test(w.code)),
    provider:           'idanalyzer',
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

// The form scans the photo, then the save sends the same photo and the server
// reads it again. Remembering the answer by the photo's hash keeps that to one
// ID Analyzer credit. Per server instance; a miss just scans again.
//
// The Scan / Re-scan button passes fresh: it always reads the card again and
// replaces the remembered answer, so a re-scan can fix a bad read (before, the
// same photo returned the same wrong answer for 30 minutes), and the save then
// checks against what the form last showed.
const SCAN_CACHE_MS  = 30 * 60_000
const SCAN_CACHE_MAX = 100
const scanCache = new Map<string, { at: number; result: LicenseOCRResult }>()

export async function extractLicenseData(
  buffer: Buffer,
  opts: { fresh?: boolean } = {},
): Promise<LicenseOCRResult> {
  const key = createHash('sha256').update(buffer).digest('hex')
  const hit = opts.fresh ? undefined : scanCache.get(key)
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit.result
  scanCache.delete(key)

  if (!IDANALYZER_API_KEY) {
    logSystemThrottled('idanalyzer.not-configured', 60 * 60_000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'idanalyzer.config',
      message:    'IDANALYZER_API_KEY is not set, so licenses cannot be scanned; their details are typed by hand with a note.',
      metadata:   {},
    })
    throw new Error('License scanning is not configured')
  }

  const compressed = await sharp(buffer)
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()

  let result: LicenseOCRResult
  try {
    result = await idAnalyzerScan(compressed)
  } catch (err: any) {
    // Message only: never the key or the image.
    logSystemThrottled('idanalyzer.scan', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
      log_level:  'error',
      event_type: 'external_api',
      source:     'idanalyzer.scan',
      message:    `${err?.message ?? String(err)}. The license could not be scanned; its details can be typed by hand with a note.`,
      metadata:   { status: err?.response?.status ?? null },
    })
    throw err
  }

  if (scanCache.size >= SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value!)
  scanCache.set(key, { at: Date.now(), result })
  return result
}
