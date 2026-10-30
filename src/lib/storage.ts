import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { logSystemError } from './log-system.js'

/**
 * Every uploaded file lives in one PRIVATE Cloudflare R2 bucket. Nothing in it
 * can be opened by URL alone: the database stores a reference (`r2://<key>`),
 * and the only way to reach the file is a signed link that expires.
 *
 * Signing happens on the way out (middlewares/file-urls.ts walks every JSON
 * response), so a link is only ever handed to someone the route already let
 * see that row. When a client sends a signed link back (a proof photo URL with
 * the stop confirmation, say), the same middleware turns it back into the
 * reference before validation, so a signed link is never what gets stored.
 *
 * Links are signed per hour window rather than per request: within one window
 * every reader gets the identical URL, so browsers and the mobile image cache
 * can still cache the file. A link stays valid for 1–2 hours, then dies.
 */

const ACCOUNT = process.env.R2_ACCOUNT_ID ?? ''
const BUCKET  = process.env.R2_FILES_BUCKET ?? ''
const HOST    = `${ACCOUNT}.r2.cloudflarestorage.com`

export const FILE_REF_PREFIX = 'r2://'

const WINDOW_MS      = 60 * 60 * 1000
const EXPIRES_IN_SEC = 2 * 60 * 60

const s3 = new S3Client({
  region:         'auto',
  endpoint:       `https://${HOST}`,
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
})

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Extension for an upload's MIME type (`image/png` → `png`), `bin` if unknown. */
export function extForMime(mime: string | undefined): string {
  const hit = Object.entries(CONTENT_TYPES).find(([, type]) => type === mime)
  return hit?.[0] ?? (mime?.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin')
}

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** File name reduced to characters that are safe in a key and a header. */
export function safeFileName(originalName: string): string {
  const ext  = originalName.split('.').pop()?.toLowerCase() ?? ''
  const base = originalName
    .replace(/\.[^/.]+$/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 55) || 'file'
  return ext && ext !== originalName.toLowerCase() ? `${base}.${ext}` : base
}

/**
 * Stores a file and returns its reference. The random id in the key is what
 * makes it unguessable; `fileName` (documents) keeps the original name as the
 * last segment so the signed link can offer it on download.
 */
export async function putFile(
  buffer: Buffer,
  opts: { folder: string; ext?: string; fileName?: string; contentType?: string },
): Promise<{ ref: string; key: string; bytes: number }> {
  const id  = randomUUID()
  const ext = (opts.ext ?? opts.fileName?.split('.').pop() ?? '').toLowerCase()
  const key = opts.fileName
    ? `${opts.folder}/${id}/${opts.fileName}`
    : `${opts.folder}/${id}${ext ? `.${ext}` : ''}`

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: opts.contentType ?? contentTypeFor(ext),
    }))
  } catch (err) {
    logSystemError('storage.put', 'external_api', err, { key })
    throw err
  }
  return { ref: FILE_REF_PREFIX + key, key, bytes: buffer.length }
}

export async function deleteFile(refOrKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyOf(refOrKey) }))
  } catch (err) {
    logSystemError('storage.delete', 'external_api', err, { key: keyOf(refOrKey) })
    throw err
  }
}

export function isFileRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(FILE_REF_PREFIX)
}

export function keyOf(refOrKey: string): string {
  return refOrKey.startsWith(FILE_REF_PREFIX) ? refOrKey.slice(FILE_REF_PREFIX.length) : refOrKey
}

/** A short-lived link to the file behind `ref`. */
export async function signFileRef(ref: string, now = Date.now()): Promise<string> {
  const key      = keyOf(ref)
  const fileName = key.split('/').pop() ?? 'file'
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key:    key,
      ResponseContentDisposition: `inline; filename="${fileName}"`,
    }),
    { expiresIn: EXPIRES_IN_SEC, signingDate: new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS) },
  )
}

/**
 * The reference behind one of our signed links, or null for anything else.
 * Only links to our own bucket qualify, so a client cannot smuggle in a key by
 * pointing at some other host.
 */
export function refFromSignedUrl(value: string): string | null {
  if (!value.startsWith(`https://${HOST}/${BUCKET}/`)) return null
  try {
    const url = new URL(value)
    if (!url.searchParams.has('X-Amz-Signature')) return null
    const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length))
    return key ? FILE_REF_PREFIX + key : null
  } catch {
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Copy of `value` with every file reference swapped for a signed link. */
export async function signFileRefsDeep(value: unknown): Promise<unknown> {
  const now = Date.now()
  const walk = async (v: unknown): Promise<unknown> => {
    if (isFileRef(v)) return signFileRef(v, now)
    if (Array.isArray(v)) return Promise.all(v.map(walk))
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(v)) out[k] = await walk(child)
      return out
    }
    return v
  }
  return walk(value)
}

/** Copy of `value` with every signed link of ours swapped back to its reference. */
export function refsFromSignedUrlsDeep(value: unknown): unknown {
  if (typeof value === 'string') return refFromSignedUrl(value) ?? value
  if (Array.isArray(value)) return value.map(refsFromSignedUrlsDeep)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(value)) out[k] = refsFromSignedUrlsDeep(child)
    return out
  }
  return value
}

export const storageConfigured = Boolean(ACCOUNT && BUCKET && process.env.R2_ACCESS_KEY_ID)
