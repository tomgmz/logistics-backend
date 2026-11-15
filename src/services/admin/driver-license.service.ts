import { supabase } from '../../lib/supabase.js'
import { phDay } from '../../lib/ph-date.js'
import type { LicenseOCRResult } from './driver-ocr.service.js'

/**
 * A driver's license changing on the record: a renewal (new card, new expiry),
 * a corrected number, or a replaced photo.
 *
 * The office does it, so the checks here are the ones a person skimming a photo
 * misses:
 *
 *   - the new card is THIS driver's: an LTO license number stays with its holder
 *     across renewals, so a scan that reads a different number is almost always
 *     somebody else's license; a different name is likelier a married name or a
 *     smudged Ñ, but still has to be explained;
 *   - the expiry is a renewal's: in the future, not earlier than the one on file,
 *     and not past what LTO issues (10 years);
 *   - a code the driver held (e.g. CE for articulated trucks) is not silently lost;
 *   - the card was checked against LTO's LTMS by the person saving it, because
 *     an edited photo reads perfectly well.
 *
 * Anything unusual needs a written note, which is kept with the old license in
 * driver_license_history. The old card is never overwritten.
 */

export class LicenseCheckError extends Error {
  status = 422
  constructor(message: string, public code: 'LICENSE_NOT_VERIFIED' | 'LICENSE_NEEDS_NOTE' | 'LICENSE_INVALID' | 'NOT_A_LICENSE', public issues: string[] = []) {
    super(message)
  }
}

/** Refuse a photo that isn't a Philippine driver's license (no note makes it one). */
export function assertIsLicense(scanned: LicenseOCRResult | null): void {
  if (scanned && !scanned.is_license) {
    throw new LicenseCheckError(scanned.not_license_reason ?? "This photo doesn't look like a Philippine driver's license.", 'NOT_A_LICENSE')
  }
}

/** ID Analyzer's fake / edited card flags, as note-requiring issues. */
function fraudIssues(scanned: LicenseOCRResult | null): string[] {
  return (scanned?.fraud_warnings ?? []).map((w) =>
    `The card was flagged as possibly fake or edited: ${w.description || w.code}. Check the physical card and LTO (LTMS).`)
}

/**
 * The license number and expiry come from the card only: a photo whose number
 * or expiry can't be read is refused (a clearer photo, not typing). Skipped
 * when the scanners themselves failed (scanFailed): then typing, with a note.
 */
function assertCardRead(scanned: LicenseOCRResult | null): void {
  if (!scanned) return
  const missing = [!scanned.license_number && 'license number', !scanned.license_expiry && 'expiry'].filter(Boolean)
  if (missing.length) {
    throw new LicenseCheckError(
      `The ${missing.join(' and ')} could not be read from the card. Upload a clearer photo of the front of the license.`,
      'LICENSE_INVALID',
    )
  }
}

/** The license number is locked to what the card reads: no note changes it. */
function assertNumberMatchesCard(scanned: LicenseOCRResult | null, number: string | null | undefined): void {
  const card = scanned?.license_number
  if (card && normNumber(card) !== normNumber(number)) {
    throw new LicenseCheckError(
      `The card reads license number ${card}, but ${number || 'none'} is being saved. The license number must match the card; if the scan read it wrong, upload a clearer photo.`,
      'LICENSE_INVALID',
    )
  }
}

/** The expiry is locked to what the card reads: no note changes it. */
function assertExpiryMatchesCard(scanned: LicenseOCRResult | null, expiry: string | null): void {
  const card = day(scanned?.license_expiry)
  if (card && expiry && card !== expiry) {
    throw new LicenseCheckError(
      `The card reads expiry ${card}, but ${expiry} is being saved. The expiry must match the card; if the scan read it wrong, upload a clearer photo.`,
      'LICENSE_INVALID',
    )
  }
}

/** LTO's longest validity is 10 years; a little slack for the birthday rule. */
const MAX_VALIDITY_DAYS = 10 * 366 + 31

const MIN_NOTE = 10

interface CurrentLicense {
  driver_id:          string
  license_number:     string | null
  license_expiry:     string | null
  license_image_url:  string | null
  dl_codes:           string[] | null
  restriction_codes:  string[] | null
  license_verified_at: string | null
  license_verified_by: string | null
  users: { first_name: string | null; middle_name: string | null; last_name: string | null } | null
}

export interface LicenseChangeRequest {
  newImageUrl?:   string | null
  licenseNumber?: string
  licenseExpiry?: string
  firstName?:     string
  middleName?:    string | null
  lastName?:      string
  verified?:      boolean
  note?:          string | null
}

export interface LicenseChangePlan {
  /** Extra columns to write on drivers. */
  driverFields: Record<string, unknown>
  /** Writes the old license to history; call after the driver row is saved. */
  recordHistory: () => Promise<void>
  /** "expiry 2026-11-20 → 2031-11-20; license photo replaced" */
  summary: string
}

const normNumber = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
// Accents off (a worn Ñ reads as N), case and spacing ignored.
const normName = (s: string | null | undefined) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim()

/** Names match when every word of the shorter one is in the longer one (a middle name may ride along). */
function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normName(a).split(' ').filter(Boolean)
  const y = normName(b).split(' ').filter(Boolean)
  if (!x.length || !y.length) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.every((w) => long.includes(w))
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null)

async function loadCurrent(userId: string): Promise<CurrentLicense | null> {
  const { data, error } = await supabase
    .from('drivers')
    .select(`driver_id, license_number, license_expiry, license_image_url, dl_codes, restriction_codes,
             license_verified_at, license_verified_by, users ( first_name, middle_name, last_name )`)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const users = Array.isArray((data as any).users) ? (data as any).users[0] : (data as any).users
  return { ...(data as any), users: users ?? null }
}

/**
 * Check a license change and plan what to write. Returns null when nothing about
 * the license changes (a phone or email edit). Throws LicenseCheckError, with the
 * issues listed, when the change can't be saved as it is.
 *
 * `scanned` is what the server read off the new image (null when no new image,
 * or the scan failed).
 */
export async function planLicenseChange(
  userId: string,
  req: LicenseChangeRequest,
  scanned: LicenseOCRResult | null,
  scanFailed: boolean,
  actorId: string | null,
): Promise<LicenseChangePlan | null> {
  const cur = await loadCurrent(userId)
  if (!cur) return null

  const newImage      = !!req.newImageUrl
  const numberChanged = req.licenseNumber !== undefined && normNumber(req.licenseNumber) !== normNumber(cur.license_number)
  const expiryChanged = req.licenseExpiry !== undefined && day(req.licenseExpiry) !== day(cur.license_expiry)
  // The name is the license holder's too: changing it on the record is a
  // license change, whether or not a new card comes with it.
  const differs = (next: string | null | undefined, now: string | null | undefined) =>
    next !== undefined && normName(next) !== normName(now)
  const nameChanged = differs(req.firstName, cur.users?.first_name)
    || differs(req.middleName, cur.users?.middle_name)
    || differs(req.lastName, cur.users?.last_name)
  if (!newImage && !numberChanged && !expiryChanged && !nameChanged) return null
  const fullName = (f?: string | null, m?: string | null, l?: string | null) => [f, m, l].filter(Boolean).join(' ')
  const oldName  = fullName(cur.users?.first_name, cur.users?.middle_name, cur.users?.last_name)
  const newName  = fullName(
    req.firstName ?? cur.users?.first_name,
    req.middleName !== undefined ? req.middleName : cur.users?.middle_name,
    req.lastName ?? cur.users?.last_name,
  )

  if (!req.verified) {
    throw new LicenseCheckError(
      'Confirm you checked this license against LTO (LTMS) before saving the change.',
      'LICENSE_NOT_VERIFIED',
    )
  }

  const number    = req.licenseNumber ?? cur.license_number
  const expiry    = day(req.licenseExpiry ?? cur.license_expiry)
  const firstName = req.firstName ?? cur.users?.first_name ?? null
  const lastName  = req.lastName ?? cur.users?.last_name ?? null
  const today     = phDay()

  // Hard limits: no note makes these right.
  assertIsLicense(scanned)
  // No new photo: the number and expiry can't change (they come from the card).
  if (!newImage && (numberChanged || expiryChanged)) {
    throw new LicenseCheckError(
      "The license number and expiry come from the driver's license. Upload the new license to change them.",
      'LICENSE_INVALID',
    )
  }
  if (newImage) {
    assertCardRead(scanned)
    assertNumberMatchesCard(scanned, number)
    assertExpiryMatchesCard(scanned, expiry)
  }
  if (expiryChanged && expiry) {
    if (expiry <= today) throw new LicenseCheckError(`The new expiry (${expiry}) has already passed. Enter the renewed license's expiry.`, 'LICENSE_INVALID')
    if (expiry > addDays(today, MAX_VALIDITY_DAYS)) {
      throw new LicenseCheckError(`The new expiry (${expiry}) is more than 10 years away, longer than LTO issues. Check the date on the card.`, 'LICENSE_INVALID')
    }
  }

  // Unusual but possible: each needs the note.
  const issues: string[] = []
  if (numberChanged) {
    issues.push(`The license number changes from ${cur.license_number ?? 'none'} to ${number}. A license number normally stays the same on renewal.`)
  }
  if (nameChanged) {
    issues.push(newImage
      ? `The driver's name changes from ${oldName} to ${newName}.`
      : `The driver's name changes from ${oldName} to ${newName}, but the license on file still reads ${oldName}. Upload the new license if the name on it changed.`)
  }
  if (newImage && scanFailed) {
    issues.push('The new license image could not be read automatically, so its details were not checked.')
  }
  if (scanned) {
    const scannedFirst = scanned.first_name, scannedLast = scanned.last_name
    if ((scannedLast && !sameName(scannedLast, lastName)) || (scannedFirst && !sameName(scannedFirst, firstName))) {
      issues.push(`The uploaded card reads the name ${[scannedFirst, scannedLast].filter(Boolean).join(' ')}, not ${[firstName, lastName].filter(Boolean).join(' ')}.`)
    }
    issues.push(...fraudIssues(scanned))
    const lost = (cur.dl_codes ?? []).filter((c) => !(scanned.dl_codes ?? []).includes(c))
    if (lost.length && (scanned.dl_codes ?? []).length) {
      issues.push(`The new card no longer shows code${lost.length > 1 ? 's' : ''} ${lost.join(', ')}. Check which vehicles this driver may still drive.`)
    }
  }
  if (expiryChanged && expiry && cur.license_expiry && expiry < day(cur.license_expiry)!) {
    issues.push(`The new expiry (${expiry}) is earlier than the one on file (${day(cur.license_expiry)}).`)
  }

  const note = req.note?.trim() ?? ''
  if (issues.length && note.length < MIN_NOTE) {
    throw new LicenseCheckError(
      'This license change needs a note explaining it before it can be saved.',
      'LICENSE_NEEDS_NOTE',
      issues,
    )
  }

  const now = new Date().toISOString()
  const driverFields: Record<string, unknown> = {
    license_verified_at: now,
    license_verified_by: actorId,
  }
  // Only when the card's codes were read: an unread section must not wipe them.
  if (scanned && newImage && (scanned.dl_codes?.length || scanned.restriction_codes?.length)) {
    driverFields.dl_codes          = scanned.dl_codes ?? []
    driverFields.restriction_codes = scanned.restriction_codes ?? []
  }

  const parts: string[] = []
  if (nameChanged)   parts.push(`name ${oldName} → ${newName}`)
  if (numberChanged) parts.push(`license number ${cur.license_number ?? 'none'} → ${number}`)
  if (expiryChanged) parts.push(`expiry ${day(cur.license_expiry) ?? 'none'} → ${expiry}`)
  if (newImage)      parts.push('license photo replaced')
  if (issues.length) parts.push(`note: ${note}`)

  return {
    driverFields,
    summary: parts.join('; '),
    recordHistory: async () => {
      const { error } = await supabase.from('driver_license_history').insert({
        driver_id:         cur.driver_id,
        license_number:    cur.license_number,
        license_expiry:    cur.license_expiry,
        license_image_url: cur.license_image_url,
        dl_codes:          cur.dl_codes,
        restriction_codes: cur.restriction_codes,
        verified_at:       cur.license_verified_at,
        verified_by:       cur.license_verified_by,
        replaced_at:       now,
        replaced_by:       actorId,
        change_note:       issues.length ? `${note}\n\nChecked: ${issues.join(' ')}` : note || null,
        scanned:           scanned ?? null,
      })
      if (error) throw error
    },
  }
}

/** The licenses a driver held before, newest first (staff reading the record). */
export async function licenseHistory(userId: string) {
  const { data: d, error: dErr } = await supabase.from('drivers').select('driver_id').eq('user_id', userId).maybeSingle()
  if (dErr) throw dErr
  if (!d) return []
  const { data, error } = await supabase
    .from('driver_license_history')
    .select('history_id, license_number, license_expiry, license_image_url, dl_codes, replaced_at, change_note, replacer:users!driver_license_history_replaced_by_fkey ( first_name, last_name )')
    .eq('driver_id', d.driver_id)
    .order('replaced_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export interface LicenseCreateRequest {
  licenseNumber: string
  licenseExpiry: string
  firstName:     string
  lastName:      string
  verified?:     boolean
  note?:         string | null
}

/**
 * The same checks for a NEW driver. The form fills the name and license
 * details from the card, but each field can be edited, so a driver could be
 * saved under one person's details with another person's card. Here the server
 * compares what is being saved with its own scan of the card, requires the LTMS
 * check, and wants a note for anything that differs. Returns the extra driver
 * columns to store (codes, who checked it). Throws LicenseCheckError.
 */
export function planLicenseCreate(
  req: LicenseCreateRequest,
  scanned: LicenseOCRResult | null,
  scanFailed: boolean,
  actorId: string | null,
): Record<string, unknown> {
  if (!req.verified) {
    throw new LicenseCheckError(
      'Confirm you checked this license against LTO (LTMS) before creating the driver.',
      'LICENSE_NOT_VERIFIED',
    )
  }
  const expiry = day(req.licenseExpiry)
  assertIsLicense(scanned)
  assertCardRead(scanned)
  assertNumberMatchesCard(scanned, req.licenseNumber)
  assertExpiryMatchesCard(scanned, expiry)
  if (expiry && expiry > addDays(phDay(), MAX_VALIDITY_DAYS)) {
    throw new LicenseCheckError(`The expiry (${expiry}) is more than 10 years away, longer than LTO issues. Check the date on the card.`, 'LICENSE_INVALID')
  }

  const issues: string[] = []
  if (scanFailed) issues.push('The license image could not be read automatically, so its details were not checked.')
  if (scanned) {
    if ((scanned.last_name && !sameName(scanned.last_name, req.lastName)) || (scanned.first_name && !sameName(scanned.first_name, req.firstName))) {
      issues.push(`The card reads the name ${[scanned.first_name, scanned.last_name].filter(Boolean).join(' ')}, but ${req.firstName} ${req.lastName} is being saved.`)
    }
    issues.push(...fraudIssues(scanned))
  }
  const note = req.note?.trim() ?? ''
  if (issues.length && note.length < MIN_NOTE) {
    throw new LicenseCheckError('These license details need a note explaining them before the driver can be created.', 'LICENSE_NEEDS_NOTE', issues)
  }

  return {
    license_verified_at: new Date().toISOString(),
    license_verified_by: actorId,
    ...(scanned && (scanned.dl_codes?.length || scanned.restriction_codes?.length)
      ? { dl_codes: scanned.dl_codes ?? [], restriction_codes: scanned.restriction_codes ?? [] }
      : {}),
  }
}

/** Store the creation check's columns on the new driver row. */
export async function saveLicenseCreateFields(userId: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('drivers').update(fields).eq('user_id', userId)
  if (error) throw error
}
