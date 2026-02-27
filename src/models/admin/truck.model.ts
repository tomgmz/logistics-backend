import { supabase } from '../../lib/supabase.js'
import { CreateTruckInput, UpdateTruckInput } from '../../types/truck.types.js'

async function findAll() {
  const { data, error } = await supabase
    .from('trucks')
    .select('*')
    .neq('status', 'archived')
    .order('plate_number', { ascending: true })

  if (error) throw error
  return data
}

async function findById(truckId: string) {
  const { data, error } = await supabase
    .from('trucks')
    .select('*')
    .eq('truck_id', truckId)
    .neq('status', 'archived')
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(input: CreateTruckInput) {
  const { data, error } = await supabase
    .from('trucks')
    .insert({
      plate_number:     input.plate_number,
      truck_type:       input.truck_type,
      capacity_tons:    input.capacity_tons,
      owned_by:         input.owned_by,
      subcontractor_id: input.subcontractor_id ?? null,
    })
    .select()
    .single()

  if (error) throw error

  await supabase.from('system_logs').insert({
    user_id:     input.created_by ?? null,
    log_type:    'truck_activity',
    action:      'truck_creation',
    description: `Truck ${input.plate_number} created.`,
  })

  return data
}

async function update(truckId: string, input: UpdateTruckInput) {
  const truckFields: Record<string, any> = {}
  if (input.plate_number     !== undefined) truckFields.plate_number     = input.plate_number
  if (input.truck_type       !== undefined) truckFields.truck_type       = input.truck_type
  if (input.capacity_tons    !== undefined) truckFields.capacity_tons    = input.capacity_tons
  if (input.status           !== undefined) truckFields.status           = input.status
  if (input.owned_by         !== undefined) truckFields.owned_by         = input.owned_by
  if (input.subcontractor_id !== undefined) truckFields.subcontractor_id = input.subcontractor_id

  if (Object.keys(truckFields).length > 0) {
    const { error } = await supabase.from('trucks').update(truckFields).eq('truck_id', truckId)
    if (error) throw error
  }

  return findById(truckId)
}

async function remove(truckId: string) {
  const { data, error } = await supabase
    .from('trucks')
    .update({ status: 'archived' })
    .eq('truck_id', truckId)
    .select('truck_id, status')

  if (error) throw error
  if (!data || data.length === 0) throw new Error(`No truck found with ID: ${truckId}`)
  return true
}

export { findAll, findById, create, update, remove }