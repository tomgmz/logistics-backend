import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import opentype from 'opentype.js'
import sharp from 'sharp'

/**
 * The time-and-place stamp burned into every pickup / drop-off proof photo.
 *
 * Same idea as a "geocam" app's overlay — plate, time, date, where — drawn by
 * the SERVER rather than the phone, so the driver cannot edit it and the photo
 * that reaches Cloudinary is already the evidence.
 *
 * Text is drawn as vector outlines from the bundled Barlow fonts, never as SVG
 * <text>. librsvg resolves <text> through the host's fontconfig, and a bare
 * server image usually has no fonts at all — every letter would come out as an
 * empty box. Outlines render the same on any host.
 */

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/proof-stamp')

// Loaded on first use, not at import: a missing asset must fail one stamp (and
// fall back to the unstamped photo), never the whole process at boot.
let fonts: { medium: opentype.Font; semibold: opentype.Font; bold: opentype.Font; condensed: opentype.Font } | null = null
let logoDataUri: string | null = null
let logoAspect = 1

function loadAssets() {
  if (fonts) return fonts
  const font = (file: string) => {
    const buf = readFileSync(path.join(ASSET_DIR, file))
    return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  }
  fonts = {
    medium:    font('Barlow-Medium.ttf'),
    semibold:  font('Barlow-SemiBold.ttf'),
    bold:      font('Barlow-Bold.ttf'),
    condensed: font('BarlowSemiCondensed-Bold.ttf'),
  }
  const logo = readFileSync(path.join(ASSET_DIR, 'logo.png'))
  // logo.png is 900x191; read from the header so a replaced logo keeps its shape.
  logoAspect  = logo.readUInt32BE(16) / logo.readUInt32BE(20)
  logoDataUri = `data:image/png;base64,${logo.toString('base64')}`
  return fonts
}

/* ── What goes on the stamp ───────────────────────────────────────────────── */

export interface ProofStampData {
  /** When the photo was taken. */
  takenAt:      Date
  /**
   * When the server received it, shown only when it is far from `takenAt` — a
   * photo uploaded hours later from a dead zone, or a phone with its clock set
   * wrong, is then visible on the photo itself.
   */
  receivedAt?:  Date | null
  plate?:       string | null
  /** e.g. "PICKUP" / "DROP-OFF 2 OF 3". */
  stopLabel?:   string | null
  /** e.g. "TRIP 1 OF 2". */
  tripLabel?:   string | null
  address?:     string | null
  latitude?:    number | null
  longitude?:   number | null
  accuracyM?:   number | null
  bookingRef?:  string | null
  driverName?:  string | null
  /** The photo was added to a stop already confirmed — not taken at the moment of confirming. */
  addedLater?:  boolean
}

/* ── Philippine time ──────────────────────────────────────────────────────── */

// Fixed UTC+8, no DST — the same constant ph-date.ts uses, for the same reason.
const PH_OFFSET_MS = 8 * 60 * 60 * 1000
const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')

function phParts(at: Date) {
  const d = new Date(at.getTime() + PH_OFFSET_MS)
  return {
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    date: `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()}`,
    short: `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  }
}

/** "3 h 5 min after the photo was taken" — or before it, when the phone's clock is ahead. */
function gap(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60_000)
  const h = Math.floor(mins / 60)
  const span = h >= 48 ? `${Math.round(h / 24)} days` : h > 0 ? (mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`) : `${mins} min`
  return ms >= 0 ? `${span} after the photo was taken` : `${span} BEFORE the photo's time — check the phone's clock`
}

// More than this between "taken" and "received" is worth printing.
const LATE_UPLOAD_MS = 10 * 60 * 1000

/* ── Text as outlines ─────────────────────────────────────────────────────── */

function measure(font: opentype.Font, text: string, size: number, tracking = 0): number {
  const scale  = size / font.unitsPerEm
  const glyphs = font.stringToGlyphs(text)
  let width = 0
  glyphs.forEach((g, i) => {
    width += (g.advanceWidth ?? 0) * scale
    if (i < glyphs.length - 1) width += font.getKerningValue(g, glyphs[i + 1]) * scale + tracking
  })
  return width
}

/** SVG path data for `text` with its baseline at (x, y). */
function outline(font: opentype.Font, text: string, x: number, y: number, size: number, tracking = 0): string {
  const scale  = size / font.unitsPerEm
  const glyphs = font.stringToGlyphs(text)
  let cursor = x
  let d = ''
  glyphs.forEach((g, i) => {
    d += g.getPath(cursor, y, size).toPathData(1)
    cursor += (g.advanceWidth ?? 0) * scale
    if (i < glyphs.length - 1) cursor += font.getKerningValue(g, glyphs[i + 1]) * scale + tracking
  })
  return d
}

/** Greedy word wrap; the last allowed line is ellipsised rather than dropped. */
function wrap(font: opentype.Font, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (measure(font, next, size) <= maxWidth || !line) { line = next; continue }
    lines.push(line)
    line = word
  }
  if (line) lines.push(line)
  if (lines.length <= maxLines) return lines

  const kept = lines.slice(0, maxLines)
  let last = kept[maxLines - 1]
  while (last.length > 1 && measure(font, `${last}…`, size) > maxWidth) last = last.slice(0, -1).trimEnd()
  kept[maxLines - 1] = `${last}…`
  return kept
}

function formatCoord(value: number, pos: string, neg: string): string {
  return `${Math.abs(value).toFixed(5)}° ${value >= 0 ? pos : neg}`
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

const TEAL  = '#4EF9EA'   // the logo's "LOGISTICS"
const AMBER = '#FFC94D'
const INK   = '#0B1B3A'

/**
 * The overlay for an image of `width` x `height`, as an SVG of the same size.
 *
 * Everything is laid out in "units" of a 1000-unit-wide panel and scaled to the
 * photo's size, so the stamp reads the same in portrait and landscape and at any
 * resolution.
 */
function buildOverlay(width: number, height: number, data: ProofStampData): string {
  const f = loadAssets()
  // Capped by 3/4 of the height so a landscape photo's stamp covers about the
  // same share of the frame as a portrait one's, not 40% of it.
  const u = Math.min(width, height * 0.75) / 1000
  const W = width / u                       // panel width in units
  const pad = 40
  const contentW = W - pad * 2

  const parts: string[] = []
  const text = (font: opentype.Font, s: string, x: number, y: number, size: number, fill: string, tracking = 0, opacity = 1) =>
    parts.push(`<path d="${outline(font, s, x, y, size, tracking)}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}/>`)

  // Built top-down from y = 0, then the whole block is shifted to sit on the
  // bottom edge once its height is known.
  let y = 0
  const { time, date } = phParts(data.takenAt)

  /* Row 1 — plate · time · date / stop */
  const heroH  = 104
  let x = pad

  if (data.plate) {
    const plate     = data.plate.toUpperCase()
    let plateSize   = 62
    // An unusually long vendor plate shrinks rather than pushing the time off.
    while (plateSize > 40 && measure(f.condensed, plate, plateSize, 3) > 300) plateSize -= 2
    const plateTextW = measure(f.condensed, plate, plateSize, 3)
    const plateW     = plateTextW + 52
    const plateH     = heroH - 8
    const py         = y + 4
    // A licence plate: white face, dark rim, a teal strip along the top.
    parts.push(
      `<rect x="${x}" y="${py}" width="${plateW}" height="${plateH}" rx="12" fill="#FFFFFF"/>`,
      `<rect x="${x + 5}" y="${py + 5}" width="${plateW - 10}" height="${plateH - 10}" rx="8" fill="none" stroke="${INK}" stroke-width="3"/>`,
      `<rect x="${x + 5}" y="${py + 5}" width="${plateW - 10}" height="13" rx="4" fill="${TEAL}"/>`,
    )
    text(f.condensed, plate, x + (plateW - plateTextW) / 2, py + plateH / 2 + plateSize * 0.36 + 6, plateSize, INK, 3)
    x += plateW + 28
  }

  const timeSize = 118
  text(f.condensed, time, x, y + heroH - 6, timeSize, '#FFFFFF')
  x += measure(f.condensed, time, timeSize) + 26

  parts.push(`<rect x="${x}" y="${y + 10}" width="4" height="${heroH - 20}" rx="2" fill="${TEAL}"/>`)
  x += 24

  const sideW = W - pad - x
  let dateSize = 36
  while (dateSize > 24 && measure(f.semibold, date, dateSize) > sideW) dateSize -= 1
  text(f.semibold, date, x, y + 46, dateSize, '#FFFFFF')

  const chip = [data.stopLabel, data.tripLabel].filter(Boolean).join('  ·  ')
  if (chip) {
    let chipSize = 25
    while (chipSize > 16 && measure(f.bold, chip, chipSize, 2) > sideW) chipSize -= 1
    text(f.bold, chip, x, y + 88, chipSize, TEAL, 2)
  }
  y += heroH + 26

  /* Row 2 — "added later" warning */
  if (data.addedLater) {
    const label = 'PHOTO ADDED AFTER THE STOP WAS CONFIRMED'
    const lw    = measure(f.bold, label, 22, 1.5)
    parts.push(`<rect x="${pad}" y="${y}" width="${lw + 28}" height="38" rx="19" fill="${AMBER}"/>`)
    text(f.bold, label, pad + 14, y + 27, 22, INK, 1.5)
    y += 38 + 20
  }

  /* Row 3 — where */
  const pinSize = 30
  const addrX   = pad + pinSize + 14
  const addrSize = 33
  const addrLine = 41
  const address = data.address?.trim()
  const coords  = data.latitude != null && data.longitude != null
    ? `${formatCoord(data.latitude, 'N', 'S')}, ${formatCoord(data.longitude, 'E', 'W')}` +
      (data.accuracyM != null ? `  ·  ±${Math.round(data.accuracyM)} m` : '')
    : null

  const pin = (top: number) => {
    // Map pin, 24x30 at (pad, top): a teardrop with a hole.
    const s = pinSize / 30
    parts.push(
      `<path transform="translate(${pad} ${top}) scale(${s})" fill="${TEAL}" fill-rule="evenodd" ` +
      `d="M12 0C5.4 0 0 5.3 0 11.9 0 20.6 12 30 12 30s12-9.4 12-18.1C24 5.3 18.6 0 12 0zm0 16.8a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>`,
    )
  }

  if (address) {
    pin(y + 4)
    const lines = wrap(f.medium, address, addrSize, W - pad - addrX, 3)
    lines.forEach((line, i) => text(f.medium, line, addrX, y + 30 + i * addrLine, addrSize, '#FFFFFF'))
    y += lines.length * addrLine + 4
    if (coords) {
      text(f.medium, coords, addrX, y + 26, 24, '#FFFFFF', 0.5, 0.72)
      y += 36
    }
  } else if (coords) {
    pin(y + 4)
    text(f.semibold, coords, addrX, y + 30, 30, '#FFFFFF')
    y += 44
  } else {
    text(f.medium, 'Location not available for this photo', pad, y + 28, 26, '#FFFFFF', 0, 0.72)
    y += 40
  }
  y += 18

  /* Row 4 — footer: booking, driver, upload time · logo */
  parts.push(`<rect x="${pad}" y="${y}" width="${contentW}" height="1.5" fill="#FFFFFF" fill-opacity="0.22"/>`)
  y += 20

  const logoH = 46
  const logoW = logoH * logoAspect
  const footW = contentW - logoW - 30

  const footLines: string[] = []
  const who = [data.bookingRef && `Booking ${data.bookingRef}`, data.driverName && `Driver ${data.driverName}`]
    .filter(Boolean).join('  ·  ')
  if (who) footLines.push(who)
  if (data.receivedAt && Math.abs(data.receivedAt.getTime() - data.takenAt.getTime()) > LATE_UPLOAD_MS) {
    footLines.push(`Uploaded ${phParts(data.receivedAt).short}, ${gap(data.receivedAt.getTime() - data.takenAt.getTime())}`)
  }
  footLines.push('Time and place stamped by 8338 Logistics')

  footLines.forEach((line, i) => {
    let size = i === 0 && who ? 24 : 20
    while (size > 14 && measure(f.medium, line, size) > footW) size -= 1
    text(f.medium, line, pad, y + 22 + i * 30, size, '#FFFFFF', 0.3, i === 0 && who ? 0.9 : 0.6)
  })
  const footH = Math.max(logoH, footLines.length * 30 - 4)
  parts.push(
    `<image x="${W - pad - logoW}" y="${y + footH - logoH}" width="${logoW}" height="${logoH}" xlink:href="${logoDataUri}"/>`,
  )
  y += footH + 34

  /* Place the block on the bottom edge, over a scrim that fades in above it. */
  const blockH = y + 34                     // + the top padding the group is translated by
  const H      = height / u
  const top    = H - blockH
  const fade   = 170
  const scrimTop = Math.max(0, top - fade)
  const fadeStop = ((top - scrimTop) / (H - scrimTop)).toFixed(3)

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#050A14" stop-opacity="0"/>
      <stop offset="${fadeStop}" stop-color="#050A14" stop-opacity="0.72"/>
      <stop offset="1" stop-color="#050A14" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${scrimTop}" width="${W}" height="${H - scrimTop}" fill="url(#scrim)"/>
  <rect x="0" y="${top}" width="${W}" height="5" fill="${TEAL}" fill-opacity="0.9"/>
  <g transform="translate(0 ${top + 34})">${parts.join('')}</g>
</svg>`
}

/* ── Public ───────────────────────────────────────────────────────────────── */

// Proof photos are evidence, not portfolio pieces. Capping the long side keeps
// the stamp proportions predictable and the stored file small.
const MAX_EDGE = 2048

/** The photo with the stamp burned in, as a JPEG. */
export async function stampProofPhoto(input: Buffer, data: ProofStampData): Promise<Buffer> {
  // .rotate() applies the EXIF orientation first, so the stamp lands on the
  // bottom of the picture as the driver saw it, not as the sensor stored it.
  const { data: base, info } = await sharp(input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true })

  const svg = buildOverlay(info.width, info.height, data)

  return sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer()
}
