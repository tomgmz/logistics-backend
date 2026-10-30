import { fileSha256, keyOf, sha256 } from './storage.js'

/**
 * Rules for files attached to one booking (client transaction documents and
 * staff documents alike):
 *
 *   - the same NAME is fine and gets a number: image.jpg, image (2).jpg, …
 *     (an iPhone names every photo image.jpg, and two different DRs can share
 *     a name, so refusing would block legitimate uploads);
 *   - the same FILE (identical bytes, whatever its name) is refused: it is
 *     already there. Compared by SHA-256 fingerprint, so a re-photographed or
 *     re-scanned page counts as a different file.
 */

/** A file already on the booking: its display name and, if stored by us, its reference. */
export interface ExistingBookingFile {
  name: string
  ref:  string | null
}

export class DuplicateBookingFileError extends Error {
  statusCode = 409
}

/** The name a stored reference displays under: the last segment of its key. */
export function nameOfRef(ref: string): string {
  return keyOf(ref).split('/').pop() ?? ref
}

/** `name`, or `name (2)`, `name (3)`, … whichever is not in `used` (case-insensitive); claims it. */
export function numberedName(name: string, used: Set<string>): string {
  const dot  = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext  = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

/**
 * Checks a batch of uploads against itself and against what the booking
 * already holds, and picks each file's display name. Throws
 * DuplicateBookingFileError (409) naming the file if any is already there.
 */
export async function planBookingUploads(
  files: { originalname: string; buffer: Buffer }[],
  existing: ExistingBookingFile[],
): Promise<{ displayName: string; sha256: string }[]> {
  const hashes = files.map((f) => sha256(f.buffer))

  const firstIndex = new Map<string, number>()
  hashes.forEach((h, i) => {
    const seen = firstIndex.get(h)
    if (seen !== undefined) {
      throw new DuplicateBookingFileError(
        `"${files[i].originalname}" is the same file as "${files[seen].originalname}". Remove one and try again.`,
      )
    }
    firstIndex.set(h, i)
  })

  const stored = existing.filter((e): e is ExistingBookingFile & { ref: string } => !!e.ref)
  const storedHashes = await Promise.all(stored.map((e) => fileSha256(e.ref)))
  for (let i = 0; i < files.length; i++) {
    const match = storedHashes.findIndex((h) => h === hashes[i])
    if (match >= 0) {
      const same = stored[match].name === files[i].originalname ? '' : ` (as "${stored[match].name}")`
      throw new DuplicateBookingFileError(`"${files[i].originalname}" is already attached to this booking${same}.`)
    }
  }

  const used = new Set(existing.map((e) => e.name.toLowerCase()))
  return files.map((f, i) => ({ displayName: numberedName(f.originalname, used), sha256: hashes[i] }))
}
