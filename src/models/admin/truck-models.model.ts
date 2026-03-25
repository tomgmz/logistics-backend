import { supabase } from '../../lib/supabase.js'
import  { CreateTruckModelInput, UpdateTruckModelInput, TruckModel } from '../../types/truck-model.types.js'
async function findAll(): Promise<TruckModel[]> {
  const { data, error } = await supabase
    .from('truck_models')
    .select('*')
    .order('name', { ascending: true })

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

async function remove(modelId: string): Promise<boolean> {
  const { error } = await supabase
    .from('truck_models')
    .delete()
    .eq('model_id', modelId)

  if (error) throw error
  return true
}

export const TruckModelModel = { findAll, findById, create, update, remove }