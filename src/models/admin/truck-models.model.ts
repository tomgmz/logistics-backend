import { supabase } from '../../lib/supabase.js'
import  { CreateTruckModelInput, UpdateTruckModelInput, TruckModel } from '../../types/truck-model.types.js'
// Postgres "undefined_column": the archived_at migration has not been applied.
const MISSING_COLUMN = '42703'

/** The catalog: every model that has not been archived. */
async function findAll(): Promise<TruckModel[]> {
  const { data, error } = await supabase
    .from('truck_models')
    .select('*')
    .is('archived_at', null)
    .order('name', { ascending: true })

  // Before migration 20260927000000 nothing can be archived yet, so the
  // unfiltered list is the right answer — don't take the catalog down over it.
  if (error?.code === MISSING_COLUMN) {
    const fallback = await supabase.from('truck_models').select('*').order('name', { ascending: true })
    if (fallback.error) throw fallback.error
    return fallback.data ?? []
  }
  if (error) throw error
  return data ?? []
}

async function findById(modelId: string): Promise<TruckModel | null> {
  const { data, error } = await supabase
    .from('truck_models')
    .select('*')
    .eq('model_id', modelId)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

async function create(input: CreateTruckModelInput): Promise<TruckModel> {
  const { data, error } = await supabase
    .from('truck_models')
    .insert(input)
    .select()
    .single()

  if (error) throw error
  return data
}

async function update(modelId: string, input: UpdateTruckModelInput): Promise<TruckModel | null> {
  const { data, error } = await supabase
    .from('truck_models')
    .update(input)
    .eq('model_id', modelId)
    .select()
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ?? null
}

/** Plates of the non-archived vehicles still built on this model. */
async function activeTruckPlates(modelId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('trucks')
    .select('plate_number')
    .eq('model_id', modelId)
    .neq('status', 'archived')
    .order('plate_number', { ascending: true })

  if (error) throw error
  return (data ?? []).map((r) => r.plate_number as string)
}

async function archive(modelId: string): Promise<boolean> {
  const { error } = await supabase
    .from('truck_models')
    .update({ archived_at: new Date().toISOString() })
    .eq('model_id', modelId)
    .is('archived_at', null)

  if (error?.code === MISSING_COLUMN) {
    throw new Error('Archiving models needs database migration 20260927000000_truck_models_archive — ask IT to apply it')
  }
  if (error) throw error
  return true
}

export const TruckModelModel = { findAll, findById, create, update, activeTruckPlates, archive }