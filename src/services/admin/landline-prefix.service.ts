import * as LandlinePrefixModel from '../../models/admin/landline-prefix.model.js'
import { logEvent } from '../../lib/log-event.js'

interface CreateLandlinePrefixDTO {
  prefix:    string
  city:      string
  region?:   string | null
  is_active?: boolean
}

interface UpdateLandlinePrefixDTO {
  prefix?:    string
  city?:      string
  region?:    string | null
  is_active?: boolean
}

export async function getAllLandlinePrefixes() {
  return LandlinePrefixModel.findAll()
}

export async function getLandlinePrefixById(prefixId: string) {
  const record = await LandlinePrefixModel.findById(prefixId)
  if (!record) throw new Error('Landline prefix not found')
  return record
}

export async function createLandlinePrefix(dto: CreateLandlinePrefixDTO, actorId?: string | null) {
  const result = await LandlinePrefixModel.create(dto)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'landline_prefix_created',
    description: `Landline prefix ${dto.prefix} (${dto.city}) created`,
  })

  return result
}

export async function updateLandlinePrefix(prefixId: string, dto: UpdateLandlinePrefixDTO, actorId?: string | null) {
  const result = await LandlinePrefixModel.update(prefixId, dto)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'landline_prefix_updated',
    description: `Landline prefix ${prefixId} updated`,
  })

  return result
}

export async function deleteLandlinePrefix(prefixId: string, actorId?: string | null) {
  const result = await LandlinePrefixModel.remove(prefixId)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'landline_prefix_deleted',
    description: `Landline prefix ${prefixId} deleted`,
  })

  return result
}