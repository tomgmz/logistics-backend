import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Cloudflare R2: where the driver app's APK lives (see app-release.service).
 *
 * Only for files too big for Cloudinary (10 MB raw limit on our plan) — every
 * other upload still goes to Cloudinary. R2 speaks the S3 API, so the AWS SDK
 * is the client. Uploads and downloads both go straight between the browser
 * and short-lived presigned URLs, never through this server or the Vercel proxy.
 *
 * Downloads are presigned on the account endpoint (*.r2.cloudflarestorage.com),
 * not the bucket's public r2.dev URL: some ISP resolvers (a Philippine home
 * connection, 2026-10-24) refuse to resolve *.r2.dev, so those links were dead. The public
 * URL (R2_PUBLIC_URL) is still stored on each release for reference only.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 * R2_PUBLIC_URL. Unset = the feature reports itself unconfigured.
 */

const ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'] as const

export function r2Configured(): boolean {
  return ENV.every((k) => !!process.env[k]?.trim())
}

let client: S3Client | null = null

function r2(): S3Client {
  if (!r2Configured()) {
    throw new Error(`Cloudflare R2 is not configured (set ${ENV.join(', ')})`)
  }
  client ??= new S3Client({
    region:   'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
  return client
}

const bucket = () => process.env.R2_BUCKET!

/** The public download URL for an object key. */
export function r2PublicUrl(key: string): string {
  return `${process.env.R2_PUBLIC_URL!.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * A URL the browser can download the object from, valid for `expiresIn`
 * seconds (R2's maximum is 7 days), saved under `fileName`.
 */
export async function r2PresignGet(key: string, fileName: string, expiresIn = 24 * 60 * 60): Promise<string> {
  return getSignedUrl(
    r2(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key:    key,
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`,
    }),
    { expiresIn },
  )
}

/** A URL the browser can PUT the file to directly, valid for `expiresIn` seconds. */
export async function r2PresignPut(key: string, contentType: string, expiresIn = 30 * 60): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn },
  )
}

/** The stored object's size, or null when nothing was uploaded under that key. */
export async function r2ObjectSize(key: string): Promise<number | null> {
  try {
    const head = await r2().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return head.ContentLength ?? null
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404) return null
    throw err
  }
}
