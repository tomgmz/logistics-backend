import axios from 'axios'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

/**
 * Reading a driver's license photo.
 *
 * ID Analyzer (api2.idanalyzer.com/scan) is the scanner: it is asked for a
 * Philippine driver's license only (restrictCountry PH, restrictType D), so it
 * says when the photo is something else, and it flags fake or edited cards.
 * Google Vision is the fallback when ID Analyzer is down, out of credits or not
 * configured: it only reads text, so our own check (LTO number format plus the
 * license's printed words) decides whether the text looks like a license, and
 * the result says the fake-card check did not run (full_check false).
 */

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY
const VISION_URL = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`

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
  name_n_checks:   NameNCheck[]
  dl_codes:        string[]
  restriction_codes: string[]
  vehicle_eligibility: VehicleEligibility
  /** False when the photo is not a Philippine driver's license; the save is refused. */
  is_license:      boolean
  /** Why it isn't one, in words for the form. */
  not_license_reason: string | null
  /** Fake / edited card flags from ID Analyzer; saving then needs a note. */
  fraud_warnings:  LicenseWarning[]
  provider:        'idanalyzer' | 'vision'
  /** False when the fallback read it: text only, no fake-card check. */
  full_check:      boolean
}

// A name word whose "N" Vision read with low confidence. A worn or smudged
// tilde makes Vision read Ñ as a plain N (and no language hint changes that),
// so the form asks the admin whether `word` should be `suggested`.
export interface NameNCheck {
  field:     'first_name' | 'last_name' | 'middle_name'
  word:      string
  suggested: string
}

// Below this, an "N" may really be an Ñ. A clear N reads at 0.9+; the
// smudged Ñ on a real license came back at 0.34.
const N_CONFIDENCE_MIN = 0.6

const VALID_SUFFIXES   = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V']
const LTO_LICENSE_RE    = /\b([A-Z]\d{2}-\d{2}-\d{6})\b/i
const DATE_RE           = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})\b/g
const EXPIRY_LABEL_RE   = /expir(?:y|ation|es?)[:\s]*/i
const NAME_LABEL_RE     = /^(name|holder)[:\s]+/i
const DL_CODE_RE        = /\b(CE|BE|A1|B1|B2|[ABCD])\b/g
const OLD_RESTRICT_RE   = /\b([1-8])\b/g

const DL_SECTION_RE     = /dl\s*code|vehicle\s*categor|condition\s*code|restriction/i

const SKIP_LINE_RE = /driver'?s?\s*licen[cs]e|republic\s+of|land\s+transportation|lto\s+|license\s*(no\.?|number|#)|expir|blood\s*type|address|birth|sex\s*[:/]|height|weight|nationality|emergency|contact|signature|thumbmark|pursuant|republic\s+act|motor\s*vehicle|^last\s*name|^first\s*name|^middle\s*name/i

const COMPOUND_PREFIXES = new Set([
  'DE', 'DEL', 'DELA', 'DI',
  'SAN', 'SANTA', 'SANTO', 'STO', 'STA',
  'VDA', 'LOS', 'LAS', 'MAC', 'MC',
])

function toISODate(raw: string | null): string | null {
  if (!raw) return null
  const normalized = raw.replace(/\//g, '-')
  const parts = normalized.split('-')
  const iso = parts[0].length === 4
    ? normalized
    : `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : iso
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

function parseName(
  line: string,
): Pick<LicenseOCRResult, 'first_name' | 'last_name' | 'middle_name' | 'suffix'> {
  const cleaned = line.replace(NAME_LABEL_RE, '').trim()
  const { cleaned: withoutSuffix, suffix } = extractSuffix(cleaned)

  if (withoutSuffix.includes(',')) {
    const [lastRaw, restRaw] = withoutSuffix.split(',', 2)
    const rest = restRaw.trim().split(/\s+/).filter(Boolean)

    if (rest.length <= 1) {
      return {
        last_name:   toTitleCase(lastRaw.trim()),
        first_name:  toTitleCase(rest[0] ?? null),
        middle_name: null,
        suffix,
      }
    }

    let middleStart = rest.length - 1
    while (middleStart > 1 && COMPOUND_PREFIXES.has(rest[middleStart - 1].toUpperCase())) {
      middleStart--
    }

    return {
      last_name:   toTitleCase(lastRaw.trim()),
      first_name:  toTitleCase(rest.slice(0, middleStart).join(' ')),
      middle_name: toTitleCase(rest.slice(middleStart).join(' ')),
      suffix,
    }
  }

  // No comma fallback
  const parts = withoutSuffix.split(/\s+/)
  if (parts.length === 1) return { first_name: toTitleCase(parts[0]), last_name: null, middle_name: null, suffix }
  if (parts.length === 2) return { first_name: toTitleCase(parts[0]), last_name: toTitleCase(parts[1]), middle_name: null, suffix }
  return {
    first_name:  toTitleCase(parts[0]),
    middle_name: toTitleCase(parts.slice(1, -1).join(' ')),
    last_name:   toTitleCase(parts[parts.length - 1]),
    suffix,
  }
}

function findExpiryDate(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (EXPIRY_LABEL_RE.test(lines[i])) {
      for (const c of [lines[i], lines[i + 1] ?? '']) {
        const matches = [...c.matchAll(DATE_RE)]
        if (matches.length > 0) return toISODate(matches[matches.length - 1][1])
      }
    }
  }
  // No date beside an expiry label: none. The expiry is locked once scanned,
  // so a guess (e.g. the latest date anywhere) would lock a wrong date in.
  return null
}

function findNameLine(lines: string[]): string | null {
  for (const line of lines) {
    const s = line.trim()
    if (SKIP_LINE_RE.test(s)) continue
    if (
      s.includes(',') &&
      /^[A-ZÁÉÍÓÚÑ\s,'.`\-]+$/i.test(s) &&
      s.length > 4 &&
      !LTO_LICENSE_RE.test(s) &&
      !/\d/.test(s)
    ) return s
  }
  for (const line of lines) {
    const s = line.trim()
    if (NAME_LABEL_RE.test(s)) return s.replace(NAME_LABEL_RE, '').trim()
  }
  for (const line of lines) {
    const s = line.trim()
    if (SKIP_LINE_RE.test(s)) continue
    if (
      /^[A-ZÁÉÍÓÚÑ\s'.`\-]+$/.test(s) &&
      s.split(/\s+/).length >= 2 &&
      s.length > 5 &&
      !LTO_LICENSE_RE.test(s) &&
      !/\d/.test(s)
    ) return s
  }
  return null
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

interface VisionSymbol { text: string; confidence?: number }

// Uppercased word → indexes of the N letters in it Vision was unsure of.
function findUncertainNs(annotation: any): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const page of annotation?.pages ?? [])
    for (const block of page.blocks ?? [])
      for (const para of block.paragraphs ?? [])
        for (const word of para.words ?? []) {
          const symbols: VisionSymbol[] = word.symbols ?? []
          const idx = symbols.flatMap((s, i) =>
            s.text.toUpperCase() === 'N' && (s.confidence ?? 1) < N_CONFIDENCE_MIN ? [i] : [])
          // Vision keeps the comma in "OLIVEROS,"; trailing marks don't shift the indexes.
          if (idx.length) out.set(symbols.map(s => s.text).join('').replace(/[,.]+$/, '').toUpperCase(), idx)
        }
  return out
}

function nameNChecks(
  name: Pick<LicenseOCRResult, 'first_name' | 'last_name' | 'middle_name'>,
  uncertain: Map<string, number[]>,
): NameNCheck[] {
  if (uncertain.size === 0) return []
  const checks: NameNCheck[] = []
  for (const field of ['first_name', 'last_name', 'middle_name'] as const) {
    for (const word of name[field]?.split(' ') ?? []) {
      const idx = uncertain.get(word.toUpperCase())
      if (!idx) continue
      const chars = [...word]
      for (const i of idx) chars[i] = chars[i] === 'n' ? 'ñ' : 'Ñ'
      checks.push({ field, word, suggested: chars.join('') })
    }
  }
  return checks
}

const NOT_LICENSE_MESSAGE =
  "This photo doesn't look like a Philippine driver's license. Take a clear photo of the front of the card, flat and without glare."

// ── Google Vision fallback: is this text a license? ─────────────────────────

// Printed on every LTO card design (2000 plastic, 2016/2021 plastic, the old paper one).
const LICENSE_WORDS_RE = /land\s*transportation|driver'?s?\s*licen[cs]e|non[-\s]?professional|student[-\s]*permit/i

function textLooksLikeLicense(fullText: string): string | null {
  if (!LTO_LICENSE_RE.test(fullText)) return `${NOT_LICENSE_MESSAGE} No LTO license number (like A01-23-456789) could be read.`
  if (!LICENSE_WORDS_RE.test(fullText) && !EXPIRY_LABEL_RE.test(fullText)) return NOT_LICENSE_MESSAGE
  return null
}

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
    const first = idaField(data, 'firstName')
    const { cleaned, suffix } = extractSuffix(first ?? '')
    name = {
      first_name:  toTitleCase(cleaned || null),
      middle_name: toTitleCase(idaField(data, 'middleName')),
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
    license_expiry:  toISODate(idaField(data, 'expiry')),
    ...name,
    name_n_checks:   [],
    dl_codes,
    restriction_codes,
    vehicle_eligibility: deriveEligibility(dl_codes, restriction_codes),
    is_license:         notLicense === null,
    not_license_reason: notLicense,
    fraud_warnings:     warnings.filter((w) => FRAUD_CODE_RE.test(w.code)),
    provider:           'idanalyzer',
    full_check:         true,
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

// The form scans the photo, then the save sends the same photo and the server
// reads it again. Remembering the answer by the photo's hash keeps that to one
// ID Analyzer credit. Per server instance; a miss just scans again.
const SCAN_CACHE_MS  = 30 * 60_000
const SCAN_CACHE_MAX = 100
const scanCache = new Map<string, { at: number; result: LicenseOCRResult }>()

export async function extractLicenseData(buffer: Buffer): Promise<LicenseOCRResult> {
  const key = createHash('sha256').update(buffer).digest('hex')
  const hit = scanCache.get(key)
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit.result

  const compressed = await sharp(buffer)
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()

  let result: LicenseOCRResult | null = null
  if (IDANALYZER_API_KEY) {
    try {
      result = await idAnalyzerScan(compressed)
    } catch (err: any) {
      // Message only: never the key or the image.
      logSystemThrottled('idanalyzer.scan', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
        log_level:  'error',
        event_type: 'external_api',
        source:     'idanalyzer.scan',
        message:    `${err?.message ?? String(err)}. The license was read by Google Vision instead (no fake-card check).`,
        metadata:   { status: err?.response?.status ?? null },
      })
    }
  } else {
    logSystemThrottled('idanalyzer.not-configured', 60 * 60_000, {
      log_level:  'warn',
      event_type: 'external_api',
      source:     'idanalyzer.config',
      message:    'IDANALYZER_API_KEY is not set, so licenses are read by Google Vision only (no fake-card check).',
      metadata:   {},
    })
  }
  if (!result) result = await visionScan(compressed)

  if (scanCache.size >= SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value!)
  scanCache.set(key, { at: Date.now(), result })
  return result
}

async function visionScan(compressed: Buffer): Promise<LicenseOCRResult> {
  if (!VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY is not set')
  const base64 = compressed.toString('base64')

  const { data } = await axios.post(
    VISION_URL,
    {
      requests: [{
        image:    { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      }],
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 },
  ).catch((err) => {
    console.error('Vision API error:', JSON.stringify(err.response?.data, null, 2))
    // Message and status only: VISION_URL carries the API key.
    logSystemThrottled('google-vision.ocr', EXTERNAL_FAILURE_LOG_WINDOW_MS, {
      log_level:  'error',
      event_type: 'external_api',
      source:     'google-vision.ocr',
      message:    `Vision API error: ${err.response?.data?.error?.message ?? err.message ?? String(err)}`,
      metadata:   { status: err.response?.status ?? null },
    })
    throw err
  })

  const annotation = data.responses?.[0]?.fullTextAnnotation
  const fullText   = annotation?.text ?? ''
  const lines    = fullText.split('\n').map((l: string) => l.trim()).filter(Boolean)

  const licenseMatch              = fullText.match(LTO_LICENSE_RE)
  const nameLine                  = findNameLine(lines)
  const { dl_codes, restriction_codes } = extractDLCodes(lines)
  const name = nameLine
    ? parseName(nameLine)
    : { first_name: null, last_name: null, middle_name: null, suffix: null }
  const notLicense = textLooksLikeLicense(fullText)

  return {
    license_number:  licenseMatch ? licenseMatch[1].toUpperCase() : null,
    license_expiry:  findExpiryDate(lines),
    ...name,
    name_n_checks:   nameNChecks(name, findUncertainNs(annotation)),
    dl_codes,
    restriction_codes,
    vehicle_eligibility: deriveEligibility(dl_codes, restriction_codes),
    is_license:         notLicense === null,
    not_license_reason: notLicense,
    fraud_warnings:     [],
    provider:           'vision',
    full_check:         false,
  }
}
