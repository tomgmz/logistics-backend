import axios from 'axios'
import sharp from 'sharp'

const VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY
if (!VISION_API_KEY) throw new Error('GOOGLE_VISION_API_KEY is not set')

const VISION_URL = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`

export interface LicenseOCRResult {
  license_number: string | null
  license_expiry:  string | null
  first_name:      string | null
  last_name:       string | null
  middle_name:     string | null
  suffix:          string | null
}

const VALID_SUFFIXES  = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V']
const LTO_LICENSE_RE  = /\b([A-Z]\d{2}-\d{2}-\d{6})\b/i
const DATE_RE         = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})\b/g
const EXPIRY_LABEL_RE = /expir(?:y|ation|es?)[:\s]*/i
const NAME_LABEL_RE   = /^(name|holder)[:\s]+/i

const SKIP_LINE_RE = /driver'?s?\s*licen[cs]e|republic\s+of|land\s+transportation|lto\s+|license\s*(no\.?|number|#)|expir|restriction|condition|blood\s*type|address|birth|sex\s*[:/]|height|weight|nationality|emergency|contact|signature|thumbmark|pursuant|republic\s+act|motor\s*vehicle|^last\s*name|^first\s*name|^middle\s*name/i

// Known Filipino compound surname prefixes — used to keep e.g. "DE GUZMAN" together
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
  return (
    str
      .toLowerCase()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .trim() || null
  )
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

    // PH license format: LAST NAME, FIRST NAME [SECOND NAME] MIDDLE NAME
    // Before comma = last name (can itself be compound: DELA CRUZ, SAN PEDRO)
    // After comma  = first name(s) followed by middle name
    //
    // Middle name detection — walk backwards from the end of `rest`:
    // if the word immediately before the current tail is a compound prefix
    // (DE, DEL, SAN, STA, etc.), absorb it so "DE GUZMAN" stays whole
    // instead of splitting into first="TRACY DE" middle="GUZMAN".

    if (rest.length <= 1) {
      // Only one word after comma — it's the first name, no middle name
      return {
        last_name:   toTitleCase(lastRaw.trim()),
        first_name:  toTitleCase(rest[0] ?? null),
        middle_name: null,
        suffix,
      }
    }

    // Find where the middle name starts by walking backwards
    let middleStart = rest.length - 1
    while (middleStart > 1 && COMPOUND_PREFIXES.has(rest[middleStart - 1].toUpperCase())) {
      middleStart--
    }

    const firstParts  = rest.slice(0, middleStart)
    const middleParts = rest.slice(middleStart)

    return {
      last_name:   toTitleCase(lastRaw.trim()),
      first_name:  toTitleCase(firstParts.join(' ')),
      middle_name: toTitleCase(middleParts.join(' ')),
      suffix,
    }
  }

  // No comma fallback — space-separated
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
  // Pass 1 — comma-separated ALL CAPS line (OLIVEROS, WILLIAM LAWRENCE MATOCINOS)
  for (const line of lines) {
    const s = line.trim()
    if (SKIP_LINE_RE.test(s)) continue
    if (
      s.includes(',') &&
      /^[A-ZÁÉÍÓÚÑ\s,'.`\-]+$/i.test(s) &&
      s.length > 4 &&
      !LTO_LICENSE_RE.test(s) &&
      !/\d/.test(s)
    ) {
      return s
    }
  }

  // Pass 2 — explicit "Name:" / "Holder:" label
  for (const line of lines) {
    const s = line.trim()
    if (NAME_LABEL_RE.test(s)) {
      return s.replace(NAME_LABEL_RE, '').trim()
    }
  }

  // Pass 3 — all-caps multi-word line with no digits (last resort)
  for (const line of lines) {
    const s = line.trim()
    if (SKIP_LINE_RE.test(s)) continue
    if (
      /^[A-ZÁÉÍÓÚÑ\s'.`\-]+$/.test(s) &&
      s.split(/\s+/).length >= 2 &&
      s.length > 5 &&
      !LTO_LICENSE_RE.test(s) &&
      !/\d/.test(s)
    ) {
      return s
    }
  }

  return null
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
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    },
  ).catch((err) => {
    console.error('Vision API error:', JSON.stringify(err.response?.data, null, 2))
    throw err
  })

  const fullText = data.responses?.[0]?.fullTextAnnotation?.text ?? ''
  const lines    = fullText.split('\n').map((l: string) => l.trim()).filter(Boolean)

  const licenseMatch = fullText.match(LTO_LICENSE_RE)
  const nameLine     = findNameLine(lines)

  return {
    license_number: licenseMatch ? licenseMatch[1].toUpperCase() : null,
    license_expiry:  findExpiryDate(lines),
    ...(nameLine
      ? parseName(nameLine)
      : { first_name: null, last_name: null, middle_name: null, suffix: null }),
  }
}