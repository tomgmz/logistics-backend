import { VehicleTypeModel } from '../../models/admin/vehicle-type.model.js'
import { logEvent } from '../../lib/log-event.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'

interface CreateVehicleTypeDTO {
  name:         string
  description?: string | null
  is_active?:   boolean
}

interface UpdateVehicleTypeDTO {
  name?:        string
  description?: string | null
  is_active?:   boolean
}

// Postgres unique_violation: the case-insensitive name index.
const isDuplicate = (e: unknown) => (e as { code?: string })?.code === '23505'
const duplicateName = (name: string) => conflict(`A vehicle type named "${name}" already exists.`)

/** Inner whitespace collapsed, ends trimmed: "  Wing   Van " → "Wing Van". */
const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ')

export async function getAllVehicleTypes(activeOnly = false) {
  return VehicleTypeModel.findAll(activeOnly)
}

export async function getVehicleTypeById(id: string) {
  const row = await VehicleTypeModel.findById(id)
  if (!row) throw notFound('Vehicle type not found')
  return row
}

export async function createVehicleType(dto: CreateVehicleTypeDTO, actorId?: string | null) {
  const name = cleanName(dto.name)
  if (!name) throw badRequest('Name is required.')
  try {
    const row = await VehicleTypeModel.create({
      name,
      description: dto.description?.trim() || null,
      is_active:   dto.is_active ?? true,
    })
    logEvent({
      user_id:     actorId,
      log_type:    'admin_activity',
      action:      'vehicle_type_created',
      description: `Vehicle type ${name} created`,
    })
    return row
  } catch (e) {
    if (isDuplicate(e)) throw duplicateName(name)
    throw e
  }
}

export async function updateVehicleType(id: string, dto: UpdateVehicleTypeDTO, actorId?: string | null) {
  const fields: UpdateVehicleTypeDTO = {}
  if (dto.name !== undefined) {
    fields.name = cleanName(dto.name)
    if (!fields.name) throw badRequest('Name is required.')
  }
  if (dto.description !== undefined) fields.description = dto.description?.trim() || null
  if (dto.is_active   !== undefined) fields.is_active   = dto.is_active

  try {
    const result = await VehicleTypeModel.update(id, fields)
    if (!result) throw notFound('Vehicle type not found')
    logEvent({
      user_id:     actorId,
      log_type:    'admin_activity',
      action:      'vehicle_type_updated',
      description: result.renamedModels > 0
        ? `Vehicle type ${result.row.name} updated (renamed on ${result.renamedModels} model${result.renamedModels === 1 ? '' : 's'})`
        : `Vehicle type ${result.row.name} updated`,
    })
    return result.row
  } catch (e) {
    if (isDuplicate(e)) throw duplicateName(fields.name ?? '')
    throw e
  }
}

/**
 * Delete a type nobody uses. While a model still carries it, deleting would
 * leave that model pointing at nothing, so the admin is told to make it
 * inactive instead (hidden from the pickers, models untouched).
 */
export async function deleteVehicleType(id: string, actorId?: string | null) {
  const existing = await VehicleTypeModel.findById(id)
  if (!existing) throw notFound('Vehicle type not found')
  if (existing.model_count > 0) {
    const n = existing.model_count
    throw conflict(
      `${existing.name} is still used by ${n} truck model${n === 1 ? '' : 's'}. `
      + 'Change those models first, or mark the type inactive to hide it from the pickers.',
    )
  }
  await VehicleTypeModel.remove(id)
  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'vehicle_type_deleted',
    description: `Vehicle type ${existing.name} deleted`,
  })
}

/**
 * The type a truck model is saved with must be one on the list, spelled the
 * way the list spells it. An inactive type is refused for a new choice, but a
 * model that already has it may keep it (`current`).
 */
export async function resolveModelVehicleType(input: string, current?: string | null): Promise<string> {
  const row = await VehicleTypeModel.findByName(input)
  if (!row) throw badRequest(`"${input.trim()}" is not a vehicle type. Add it in System Maintenance → Vehicle Types first.`)
  const keepsCurrent = current != null && current.trim().toLowerCase() === row.name.toLowerCase()
  if (!row.is_active && !keepsCurrent) {
    throw badRequest(`${row.name} is inactive. Pick another vehicle type, or reactivate it in System Maintenance.`)
  }
  return row.name
}
