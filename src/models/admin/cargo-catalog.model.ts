import { supabase } from '../../lib/supabase.js'
import {
  CreateHandlingCodeInput,
  UpdateHandlingCodeInput,
  CreateCommodityInput,
  UpdateCommodityInput,
  CreateProductInput,
  UpdateProductInput,
} from '../../types/cargo-catalog.types.js'

export async function findAllHandlingCodes(type?: 'standard' | 'additional') {
  let q = supabase
    .from('handling_codes')
    .select('*')
    .order('code', { ascending: true })

  if (type) q = q.eq('type', type)

  const { data, error } = await q
  if (error) throw error
  return data
}

export async function findHandlingCodeById(id: string) {
  const { data, error } = await supabase
    .from('handling_codes')
    .select('*')
    .eq('handling_code_id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function createHandlingCode(input: CreateHandlingCodeInput) {
  const { data, error } = await supabase
    .from('handling_codes')
    .insert({ ...input, is_active: input.is_active ?? true })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function updateHandlingCode(id: string, input: UpdateHandlingCodeInput) {
  const { data, error } = await supabase
    .from('handling_codes')
    .update(input)
    .eq('handling_code_id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function removeHandlingCode(id: string) {
  const { error } = await supabase
    .from('handling_codes')
    .delete()
    .eq('handling_code_id', id)

  if (error) throw error
  return true
}

export async function findAllCommodities() {
  const { data, error } = await supabase
    .from('commodities')
    .select('*')
    .order('name', { ascending: true })

  if (error) throw error
  return data
}

export async function findCommodityById(id: string) {
  const { data, error } = await supabase
    .from('commodities')
    .select('*')
    .eq('commodity_id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function createCommodity(input: CreateCommodityInput) {
  const { data, error } = await supabase
    .from('commodities')
    .insert({ ...input, is_active: input.is_active ?? true })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function updateCommodity(id: string, input: UpdateCommodityInput) {
  const { data, error } = await supabase
    .from('commodities')
    .update(input)
    .eq('commodity_id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function removeCommodity(id: string) {
  const { error } = await supabase
    .from('commodities')
    .delete()
    .eq('commodity_id', id)

  if (error) throw error
  return true
}

export async function findAllProducts(commodityId?: string) {
  let q = supabase
    .from('products')
    .select(`
      *,
      commodities ( name, category )
    `)
    .order('name', { ascending: true })

  if (commodityId) q = q.eq('commodity_id', commodityId)

  const { data, error } = await q
  if (error) throw error
  return data
}

export async function findProductById(id: string) {
  const { data, error } = await supabase
    .from('products')
    .select(`
      *,
      commodities ( name, category )
    `)
    .eq('product_id', id)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function createProduct(input: CreateProductInput) {
  const { data, error } = await supabase
    .from('products')
    .insert({ ...input, is_active: input.is_active ?? true })
    .select(`
      *,
      commodities ( name, category )
    `)
    .single()

  if (error) throw error
  return data
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  const { data, error } = await supabase
    .from('products')
    .update(input)
    .eq('product_id', id)
    .select(`
      *,
      commodities ( name, category )
    `)
    .single()

  if (error) throw error
  return data
}

export async function removeProduct(id: string) {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('product_id', id)

  if (error) throw error
  return true
}