import crypto from 'crypto'
import { supabase } from '../../lib/supabase.js'
import { badRequest, conflict } from '../../lib/http-error.js'
import { logEvent } from '../../lib/log-event.js'
import { r2Configured, r2ObjectSize, r2PresignPut, r2PublicUrl } from '../../lib/r2.js'

/**
 * Driver app releases: the APK drivers download from the website's /download
 * page, since the app is not on the Play Store.
 *
 * Publishing is two calls from the IT Admin portal:
 *   1. createUploadUrl — a presigned R2 URL the browser PUTs the APK to.
 *   2. publishRelease  — once the upload landed, records the version; from that
 *                        moment /download offers it.
 * The file never passes through this server (or the Vercel proxy's body limit).
 */

export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive'

/** Release APKs are 60–100 MB; anything far beyond is not the app. */
const MAX_APK_BYTES = 500 * 1024 * 1024

export interface AppRelease {
  release_id:  string
  version:     string
  notes:       string | null
  file_url:    string
  size_bytes:  number
  created_at:  string
  uploaded_by: string | null
}

function assertConfigured() {
  if (!r2Configured()) {
    throw conflict('App downloads are not set up yet: the Cloudflare R2 settings are missing on the server.')
  }
}

/** A presigned upload slot for one APK. */
export async function createUploadUrl(fileName: string, sizeBytes: number) {
  assertConfigured()
  if (!/\.apk$/i.test(fileName)) throw badRequest('Choose the app\'s .apk file.')
  if (!(sizeBytes > 0) || sizeBytes > MAX_APK_BYTES) {
    throw badRequest('That file is too large to be the app (500 MB maximum).')
  }

  // A fresh key per upload: a cached old APK can never be served under the new
  // release's URL, and a failed upload never overwrites the live one.
  const key = `android/8338-driver-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.apk`
  const uploadUrl = await r2PresignPut(key, APK_CONTENT_TYPE)
  return { key, upload_url: uploadUrl, content_type: APK_CONTENT_TYPE }
}

/** Record an uploaded APK as the newest release. */
export async function publishRelease(
  input: { key: string; version: string; notes?: string | null },
  actorId: string | null,
): Promise<AppRelease> {
  assertConfigured()
  if (!/^android\/8338-driver-[\w-]+\.apk$/.test(input.key)) throw badRequest('Unknown upload.')

  const size = await r2ObjectSize(input.key)
  if (!size) throw badRequest('The upload did not finish. Upload the file again.')

  const { data, error } = await supabase
    .from('app_releases')
    .insert({
      version:     input.version.trim(),
      notes:       input.notes?.trim() || null,
      file_key:    input.key,
      file_url:    r2PublicUrl(input.key),
      size_bytes:  size,
      uploaded_by: actorId,
    })
    .select('release_id, version, notes, file_url, size_bytes, created_at, uploaded_by')
    .single()
  if (error) throw error

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'app_release_published',
    description: `Driver app ${data.version} published for download (${(size / 1048576).toFixed(1)} MB)`,
  })

  return data as AppRelease
}

/** Every release, newest first (the IT Admin's history). */
export async function listReleases(): Promise<AppRelease[]> {
  const { data, error } = await supabase
    .from('app_releases')
    .select('release_id, version, notes, file_url, size_bytes, created_at, uploaded_by')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as AppRelease[]
}

/** What /download offers: the newest release, or null before the first upload. */
export async function latestRelease(): Promise<Omit<AppRelease, 'uploaded_by' | 'release_id'> | null> {
  const { data, error } = await supabase
    .from('app_releases')
    .select('version, notes, file_url, size_bytes, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}
