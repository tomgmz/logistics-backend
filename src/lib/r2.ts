import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Cloudflare R2: where the driver app's APK lives (see app-release.service).
 *
 * Only for files too big for Cloudinary (10 MB raw limit on our plan) — every
 * other upload still goes to Cloudinary. R2 speaks the S3 API, so the AWS SDK
 * is the client. Downloads are served from the bucket's public URL
 * (R2_PUBLIC_URL); uploads go straight from the browser to a short-lived
 * presigned URL, never through this server or the Vercel proxy.
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
