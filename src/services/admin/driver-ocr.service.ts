import axios from 'axios'
import sharp from 'sharp'

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY
if (!VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY is not set')

const VISION_URL = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`

// ── Vehicle eligibility ────────────────────────────────────────────────────
//
// LTO DL codes (new system, 2021+):
//   B2  — Light commercial vehicle (L300, FB, pick-up trucks)          N1
//   C   — Heavy commercial vehicle (6-wheeler, 10-wheeler trucks)      N2, N3
//   CE  — Heavy articulated vehicle (wing van with trailer)            O3, O4
//   D   — Passenger bus                                                M3
//   BE  — Light articulated vehicle                                    O1, O2
//
// Old restriction codes (pre-2021, may still appear on older licenses):
//   3   — trucks / heavy vehicles (≈ C)
//   5   — articulated / trailer   (≈ CE)
//   6   — heavy articulated       (≈ CE)

export interface VehicleEligibility {
  /** Can drive L300, FB van, pick-up (DL B2 / old code 2+) */
  can_drive_light_commercial: boolean
  /** Can drive 6-wheeler, 10-wheeler trucks (DL C / old code 3) */
  can_drive_heavy_truck: boolean
  /** Can drive wing van with trailer (DL CE / old codes 5, 6) */
  can_drive_articulated: boolean
  /** Can drive passenger bus (DL D) */
  can_drive_bus: boolean
}

export interface LicenseOCRResult {
  license_number:  string | null
  license_expiry:  string | null
  first_name:      string | null
  last_name:       string | null
  middle_name:     string | null
  suffix:          string | null
  /** Raw DL codes extracted from the license e.g. ["B", "B2", "C"] */
  dl_codes:        string[]
  /** Raw condition/restriction codes e.g. ["1", "2"] or ["A", "B"] */
  restriction_codes: string[]
  /** Derived eligibility flags for logistics vehicles */
  vehicle_eligibility: VehicleEligibility
}

// ── Constants ──────────────────────────────────────────────────────────────

const VALID_SUFFIXES    = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V']
const LTO_LICENSE_RE    = /\b([A-Z]\d{2}-\d{2}-\d{6})\b/i
const DATE_RE           = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})\b/g
const EXPIRY_LABEL_RE   = /expir(?:y|ation|es?)[:\s]*/i
const NAME_LABEL_RE     = /^(name|holder)[:\s]+/i
const DL_CODE_RE        = /\b(CE|BE|A1|B1|B2|[ABCD])\b/g
const OLD_RESTRICT_RE   = /\b([1-8])\b/g

// Section labels that indicate we're reading the DL codes / conditions area
const DL_SECTION_RE     = /dl\s*code|vehicle\s*categor|condition\s*code|restriction/i

const SKIP_LINE_RE = /driver'?s?\s*licen[cs]e|republic\s+of|land\s+transportation|lto\s+|license\s*(no\.?|number|#)|expir|blood\s*type|address|birth|sex\s*[:/]|height|weight|nationality|emergency|contact|signature|thumbmark|pursuant|republic\s+act|motor\s*vehicle|^last\s*name|^first\s*name|^middle\s*name/i

const COMPOUND_PREFIXES = new Set([
  'DE', 'DEL', 'DELA', 'DI',
  'SAN', 'SANTA', 'SANTO', 'STO', 'STA',
  'VDA', 'LOS', 'LAS', 'MAC', 'MC',
])

// ── Date helpers ───────────────────────────────────────────────────────────

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

// ── Text helpers ───────────────────────────────────────────────────────────

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

// ── Name parser ────────────────────────────────────────────────────────────

function parseName(
  line: string,
): Pick<LicenseOCRResult, 'first_name' | 'last_name' | 'middle_name' | 'suffix'> {
  const cleaned = line.replace(NAME_LABEL_RE, '').trim()
  const { cleaned: withoutSuffix, suffix } = extractSuffix(cleaned)

  if (withoutSuffix.includes(',')) {
    const [lastRaw, restRaw] = withoutSuffix.split(',', 2)
    const rest = restRaw.trim().split(/\s+/).filter(Boolean)

    // PH license format: LAST NAME, FIRST NAME [SECOND NAME] MIDDLE NAME
    // Middle name = last word(s); walk back through compound prefixes
    // e.g. "TRACY DE GUZMAN" → first="Tracy", middle="De Guzman"
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

// ── Expiry date finder ─────────────────────────────────────────────────────

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

// ── Name line finder ───────────────────────────────────────────────────────

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

// ── DL code extractor ──────────────────────────────────────────────────────

function extractDLCodes(lines: string[]): { dl_codes: string[]; restriction_codes: string[] } {
  const dlCodes   = new Set<string>()
  const restrCode = new Set<string>()

  // Strategy 1: scan for the DL codes / conditions section on the back of the license
  let inDLSection = false
  for (const line of lines) {
    if (DL_SECTION_RE.test(line)) { inDLSection = true; continue }

    if (inDLSection) {
      // New-style DL codes: CE, BE, A1, B1, B2, A, B, C, D
      for (const m of line.matchAll(DL_CODE_RE)) dlCodes.add(m[1].toUpperCase())
      // Old-style restriction codes: single digits 1-8
      for (const m of line.matchAll(OLD_RESTRICT_RE)) restrCode.add(m[1])
    }
  }

  // Strategy 2: full-text scan if section not found (older license layout)
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

// ── Vehicle eligibility ────────────────────────────────────────────────────

function deriveEligibility(dl_codes: string[], restriction_codes: string[]): VehicleEligibility {
  const dl   = new Set(dl_codes.map(c => c.toUpperCase()))
  const rc   = new Set(restriction_codes)

  return {
    // L300, FB van, pick-up: needs B2 (new) or old restriction 2
    can_drive_light_commercial:
      dl.has('B2') || rc.has('2'),

    // 6-wheeler, 10-wheeler: needs C (new) or old restriction 3
    can_drive_heavy_truck:
      dl.has('C') || rc.has('3'),

    // Wing van with trailer: needs CE (new) or old restrictions 5 or 6
    can_drive_articulated:
      dl.has('CE') || rc.has('5') || rc.has('6'),

    // Passenger bus: needs D (new) — no direct old-code equivalent
    can_drive_bus:
      dl.has('D'),
  }
}

// ── Main export ────────────────────────────────────────────────────────────

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
    throw err
  })

  const fullText = data.responses?.[0]?.fullTextAnnotation?.text ?? ''
  const lines    = fullText.split('\n').map((l: string) => l.trim()).filter(Boolean)

  const licenseMatch              = fullText.match(LTO_LICENSE_RE)
  const nameLine                  = findNameLine(lines)
  const { dl_codes, restriction_codes } = extractDLCodes(lines)

  return {
    license_number:  licenseMatch ? licenseMatch[1].toUpperCase() : null,
    license_expiry:  findExpiryDate(lines),
    ...(nameLine
      ? parseName(nameLine)
      : { first_name: null, last_name: null, middle_name: null, suffix: null }),
    dl_codes,
    restriction_codes,
    vehicle_eligibility: deriveEligibility(dl_codes, restriction_codes),
  }
}
