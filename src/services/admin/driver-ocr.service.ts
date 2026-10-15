import axios from 'axios'
import sharp from 'sharp'
import { logSystemThrottled, EXTERNAL_FAILURE_LOG_WINDOW_MS } from '../../lib/log-system.js'

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
if (!VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY is not set');

const VISION_URL = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`

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
    const re = new RegExp(`\\b${s.replace('.', '\\.')}\\b`, 'i')
    if (re.test(name)) {
      return { cleaned: name.replace(re, '').replace(/\s{2,}/g, ' ').trim(), suffix: s }
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
  const allDates: string[] = []
  for (const line of lines) {
    for (const m of line.matchAll(DATE_RE)) {
      const iso = toISODate(m[1])
      if (iso) allDates.push(iso)
    }
  }
  return allDates.length ? allDates.sort()[allDates.length - 1] : null
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

export async function extractLicenseData(buffer: Buffer): Promise<LicenseOCRResult> {
  const compressed = await sharp(buffer)
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()

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

  return {
    license_number:  licenseMatch ? licenseMatch[1].toUpperCase() : null,
    license_expiry:  findExpiryDate(lines),
    ...name,
    name_n_checks:   nameNChecks(name, findUncertainNs(annotation)),
    dl_codes,
    restriction_codes,
    vehicle_eligibility: deriveEligibility(dl_codes, restriction_codes),
  }
}
