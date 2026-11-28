/**
 * Database ids in web addresses, masked (user 2026-11-28: no uuid in a URL).
 * Links this server writes (notifications, emails) carry the code, not the id.
 *
 * Same coder as the web's lib/masked-id.ts: keep the two byte-for-byte in step,
 * or links from notifications stop opening. Not the security boundary: every
 * record is still access-checked.
 */

export type MaskedKind = 'client' | 'vehicle' | 'report' | 'request' | 'issue' | 'conversation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Za-z0-9_-]{22}$/
const B64  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const KEY  = [0x9e3779b9, 0x7f4a7c15, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1]

function tweak(kind: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function mix(a: number, b: number, k: number): number {
  let h = Math.imul(a ^ k, 0x85ebca6b) ^ b
  h ^= h >>> 15
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 13
  h = Math.imul(h ^ (a >>> 7), 0x27d4eb2f)
  h ^= h >>> 16
  return h >>> 0
}

/** 4 words in, 4 words out; `back` runs the rounds in reverse. */
function shuffle(w: number[], kind: string, back: boolean): number[] {
  const t = tweak(kind)
  let [l0, l1, r0, r1] = w
  if (!back) {
    for (let i = 0; i < KEY.length; i++) {
      const k = (KEY[i] ^ t) >>> 0
      const n0 = (l0 ^ mix(r0, r1, k)) >>> 0
      const n1 = (l1 ^ mix(r1, r0, k ^ 0x5bd1e995)) >>> 0
      l0 = r0; l1 = r1; r0 = n0; r1 = n1
    }
  } else {
    for (let i = KEY.length - 1; i >= 0; i--) {
      const k = (KEY[i] ^ t) >>> 0
      const p0 = (r0 ^ mix(l0, l1, k)) >>> 0
      const p1 = (r1 ^ mix(l1, l0, k ^ 0x5bd1e995)) >>> 0
      r0 = l0; r1 = l1; l0 = p0; l1 = p1
    }
  }
  return [l0, l1, r0, r1]
}

function toWords(bytes: number[]): number[] {
  const w: number[] = []
  for (let i = 0; i < 16; i += 4) w.push(((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0)
  return w
}

function toBytes(w: number[]): number[] {
  const b: number[] = []
  for (const x of w) b.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255)
  return b
}

function encode64(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += B64[n & 63]
  }
  return out
}

function decode64(s: string): number[] {
  const bytes: number[] = []
  let buf = 0, bits = 0
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 255) }
  }
  return bytes
}

/** The code for an id. A value that isn't a uuid (e.g. 'none') is returned as it is. */
export function maskId(kind: MaskedKind, id: string): string {
  if (!UUID.test(id)) return id
  const hex = id.replace(/-/g, '').toLowerCase()
  const bytes: number[] = []
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return encode64(toBytes(shuffle(toWords(bytes), kind, false)))
}

/** The id an address value names: a code or an older link's raw uuid. null for anything else. */
export function unmaskId(kind: MaskedKind, value: string | null | undefined): string | null {
  const v = value?.trim()
  if (!v) return null
  if (UUID.test(v)) return v.toLowerCase()
  if (!CODE.test(v)) return null
  const bytes = decode64(v)
  // Exactly 16 bytes and no stray bits in the last character.
  if (bytes.length !== 16 || encode64(bytes) !== v) return null
  const hex = toBytes(shuffle(toWords(bytes), kind, true)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}


// ── Text in an address (an email a notification opens a list on) ───────────
// `?account=<code>` in place of `?search=<email>` (user 2026-11-29). A random
// 4-byte start keeps two codes of the same email different; the rest is the
// text's UTF-8 bytes mixed with a keyed stream. Same caveat as ids: it hides
// the text from the address bar and history, it is not encryption.

export type MaskedTextKind = 'account'

function streamByte(nonce: number, i: number, t: number): number {
  const block = i >>> 2
  const w = mix((nonce ^ Math.imul(block + 1, 0x9e3779b9)) >>> 0, block, (KEY[block % KEY.length] ^ t) >>> 0)
  return (w >>> ((i & 3) * 8)) & 255
}

/** The code for a piece of text (e.g. an email address). */
export function maskText(kind: MaskedTextKind, text: string): string {
  const nonce = Math.floor(Math.random() * 0x100000000) >>> 0
  const t = tweak(kind)
  const out = [(nonce >>> 24) & 255, (nonce >>> 16) & 255, (nonce >>> 8) & 255, nonce & 255]
  Array.from(new TextEncoder().encode(text)).forEach((b, i) => out.push(b ^ streamByte(nonce, i, t)))
  return encode64(out)
}

/** The text a code names, or null when it isn't one. */
export function unmaskText(kind: MaskedTextKind, value: string | null | undefined): string | null {
  const v = value?.trim()
  if (!v || !/^[A-Za-z0-9_-]{7,}$/.test(v)) return null
  const bytes = decode64(v)
  if (bytes.length < 5 || encode64(bytes) !== v) return null
  const nonce = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  const t = tweak(kind)
  const plain = bytes.slice(4).map((b, i) => b ^ streamByte(nonce, i, t))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(plain)) } catch { return null }
}
