import 'dotenv/config'
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { FILE_REF_PREFIX, keyOf, linkPolicy } from './storage.js'

/**
 * Sealed file links (2026-11-07): what the API hands out instead of R2 signed
 * URLs, so the storage location never shows in the page, the browser's
 * Sources / Network panels or a copied link.
 *
 *   https://<api host>/api/files/<id>/<name>?t=<sealed>&e=<expires>
 *
 *  - `t` is the storage key + expiry, encrypted and authenticated with
 *    AES-256-GCM under a server-only key. Without that key it reveals nothing
 *    and cannot be forged or edited (routes/files.routes.ts decrypts it and
 *    streams the file).
 *  - `id` is an HMAC of the key: stable for one file across windows, so the
 *    web's useSignedLinkRefresh can swap a fresh link in for the old one. It
 *    reveals nothing either.
 *  - `name` is the file's own name (a uuid.jpg, or a document's original
 *    name), kept so screens can still tell a photo from a PDF and offer the
 *    name on download.
 *  - `e` is the expiry in plain sight, only so the web knows when to re-read;
 *    the server trusts the copy inside `t`.
 *
 * Since 2026-11-08 a sealed link is NOT enough on its own: it names the
 * account it was issued to, and GET /api/files also needs that account's
 * session (the driver app sends its Bearer token) or a single-use 60-second
 * web pass (makeGrant). It is only handed to people the route already let see
 * the row, and it expires on the same policy
 * (lib/storage linkPolicy): 10–15 minutes for licences / booking documents /
 * contracts, 1–2 hours otherwise. Within one time window every reader gets the
 * same link, so browser and app image caches keep working.
 */

// FILE_LINK_SECRET is preferred; JWT_SECRET keeps a deploy without it working.
// Changing either only breaks links already handed out (they last ≤ 2 h).
const SECRET = process.env.FILE_LINK_SECRET || process.env.JWT_SECRET || ''
if (!SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FILE_LINK_SECRET (or JWT_SECRET) must be set: file links are sealed with it.')
}
const KEY       = Buffer.from(hkdfSync('sha256', SECRET, 'file-links', 'aes-256-gcm', 32))
const ID_KEY    = Buffer.from(hkdfSync('sha256', SECRET, 'file-links', 'file-id', 32))
const GRANT_KEY = Buffer.from(hkdfSync('sha256', SECRET, 'file-links', 'grant-aes-256-gcm', 32))

/** How long a web pass (grant) lives; it is also single-use. */
export const GRANT_TTL_SEC = 60

export const FILE_ROUTE = '/api/files'

const b64u    = (b: Buffer) => b.toString('base64url')
const fromB64 = (s: string) => Buffer.from(s, 'base64url')

/** Opaque, stable id for one stored file. */
export function fileIdOf(key: string): string {
  return b64u(createHmac('sha256', ID_KEY).update(key).digest().subarray(0, 16))
}

/**
 * Encrypts a small JSON value. The IV is derived from the plaintext (SIV
 * style): the same plaintext gives the same token (a link stays cacheable
 * within its window), and two different plaintexts never share an IV.
 */
function encrypt(aesKey: Buffer, value: object): string {
  const plain = Buffer.from(JSON.stringify(value))
  const iv    = createHmac('sha256', aesKey).update(plain).digest().subarray(0, 12)
  const c     = createCipheriv('aes-256-gcm', aesKey, iv)
  const body  = Buffer.concat([c.update(plain), c.final()])
  return b64u(Buffer.concat([iv, body, c.getAuthTag()]))
}

function decrypt(aesKey: Buffer, token: string): Record<string, unknown> | null {
  try {
    const raw = fromB64(token)
    if (raw.length < 12 + 16 + 2) return null
    const iv  = raw.subarray(0, 12)
    const tag = raw.subarray(raw.length - 16)
    const d   = createDecipheriv('aes-256-gcm', aesKey, iv)
    d.setAuthTag(tag)
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])
    const v = JSON.parse(plain.toString('utf8'))
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

export interface SealedFile {
  key:          string
  expiresAtSec: number
  /** The account the link was issued to; null when the response had no signed-in user. */
  userId:       string | null
}

/** The file, expiry and owner inside a sealed token, or null if it was not made by us / was edited. */
export function unseal(token: string): SealedFile | null {
  const v = decrypt(KEY, token)
  if (!v || typeof v.k !== 'string' || typeof v.x !== 'number') return null
  return { key: v.k, expiresAtSec: v.x, userId: typeof v.u === 'string' ? v.u : null }
}

/**
 * A web pass (2026-11-08): lets the browser fetch ONE file ONCE, within
 * GRANT_TTL_SEC, without a session on the API host (the web's session cookie
 * is sealed by Next and only its proxy can present it). Issued by
 * POST /api/files/grants to the link's own user only.
 */
export function makeGrant(key: string, userId: string, nonce: string): string {
  return encrypt(GRANT_KEY, { k: key, u: userId, n: nonce, x: Math.floor(Date.now() / 1000) + GRANT_TTL_SEC })
}

export function openGrant(token: string): { key: string; userId: string; nonce: string; expiresAtSec: number } | null {
  const v = decrypt(GRANT_KEY, token)
  if (!v || typeof v.k !== 'string' || typeof v.u !== 'string' || typeof v.n !== 'string' || typeof v.x !== 'number') return null
  return { key: v.k, userId: v.u, nonce: v.n, expiresAtSec: v.x }
}

/** Whether `id` is the id of `key` (constant time). */
export function idMatches(id: string, key: string): boolean {
  const a = Buffer.from(id)
  const b = Buffer.from(fileIdOf(key))
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A sealed link to the file behind `ref`, on the API at `baseUrl`, for
 * `userId` (2026-11-08: opening it needs that user's session or a web pass,
 * so a copied link is useless to anyone else).
 */
export function sealFileRef(ref: string, baseUrl: string, userId: string | null, now = Date.now()): string {
  const key  = keyOf(ref)
  const { windowMs, expiresInSec } = linkPolicy(key)
  const expiresAtSec = Math.floor((Math.floor(now / windowMs) * windowMs) / 1000) + expiresInSec
  const name = key.split('/').pop() || 'file'
  return `${baseUrl.replace(/\/+$/, '')}${FILE_ROUTE}/${fileIdOf(key)}/${encodeURIComponent(name)}` +
    `?t=${encrypt(KEY, userId ? { k: key, x: expiresAtSec, u: userId } : { k: key, x: expiresAtSec })}&e=${expiresAtSec}`
}

/**
 * The reference behind one of our sealed links, or null for anything else.
 * The host is not checked: only the server can make a token that unseals.
 * Expired links still map back (a stop confirmation queued offline for hours
 * must still name its photo); only reading the file needs a live link.
 */
export function refFromSealedUrl(value: string): string | null {
  if (!value.includes(`${FILE_ROUTE}/`)) return null
  try {
    const url = new URL(value)
    const t = url.searchParams.get('t')
    const sealed = t ? unseal(t) : null
    return sealed ? FILE_REF_PREFIX + sealed.key : null
  } catch {
    return null
  }
}

/**
 * The public base URL of this API, for building links in a response. Set
 * FILE_LINK_BASE_URL to pin it; otherwise it is the host the request came in
 * on (the web's Vercel proxy calls the API host directly, so that is right for
 * the web and the app alike).
 */
export function publicBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const pinned = process.env.FILE_LINK_BASE_URL?.trim()
  if (pinned) return pinned
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`
}
