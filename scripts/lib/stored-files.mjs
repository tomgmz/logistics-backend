import 'dotenv/config'
import { S3Client, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

/**
 * File deletion for the purge scripts. Every uploaded file lives in the private
 * R2 bucket and the database holds an `r2://<key>` reference to it (see
 * src/lib/storage.ts), so a purge collects the references from the rows it
 * removes and deletes those objects once the database has committed.
 */

const s3 = new S3Client({
  region:         'auto',
  endpoint:       `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
})
const Bucket = process.env.R2_FILES_BUCKET

/** Matches every stored-file reference in a row serialised to JSON. */
export const FILE_REF = /r2:\/\/[^"\s\\,}\]]+/g

/** `{ ref, key }` for a reference, or null for anything else. */
export function assetFromRef(ref) {
  return typeof ref === 'string' && ref.startsWith('r2://') && ref.length > 5
    ? { ref, key: ref.slice(5) }
    : null
}

/** Deletes one stored file; resolves to 'ok' or 'fail — <reason>'. */
export async function deleteStoredFile(asset) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket, Key: asset.key }))
    return 'ok'
  } catch (err) {
    return `fail — ${err.message}`
  }
}

/** Deletes every object under `prefix` (e.g. 'delivery_proofs/'); resolves to the count. */
export async function deleteStoredPrefix(prefix) {
  let deleted = 0
  let ContinuationToken
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }))
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }))
    if (keys.length) {
      const res = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }))
      deleted += keys.length - (res.Errors?.length ?? 0)
    }
    ContinuationToken = page.NextContinuationToken
  } while (ContinuationToken)
  return deleted
}
