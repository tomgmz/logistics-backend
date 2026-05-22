import { supabase } from '../../lib/supabase.js'

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

async function findAll() {
  const { data, error } = await supabase
    .from('landline_prefixes')
    .select('*')
    .order('prefix', { ascending: true })

  if (error) throw error
  return data
}

async function findById(prefixId: string) {
  const { data, error } = await supabase
    .from('landline_prefixes')
    .select('*')
    .eq('prefix_id', prefixId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function create(dto: CreateLandlinePrefixDTO) {
  const { data, error } = await supabase
    .from('landline_prefixes')
    .insert({
      prefix:    dto.prefix,
      city:      dto.city,
      region:    dto.region ?? null,
      is_active: dto.is_active ?? true,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

async function update(prefixId: string, dto: UpdateLandlinePrefixDTO) {
  const fields: Record<string, unknown> = {}
  if (dto.prefix    !== undefined) fields.prefix    = dto.prefix
  if (dto.city      !== undefined) fields.city      = dto.city
  if (dto.region    !== undefined) fields.region    = dto.region
  if (dto.is_active !== undefined) fields.is_active = dto.is_active

  if (Object.keys(fields).length > 0) {
    const { error } = await supabase
      .from('landline_prefixes')
      .update(fields)
      .eq('prefix_id', prefixId)
    if (error) throw error
  }

  return findById(prefixId)
}

async function remove(prefixId: string) {
  const { data, error } = await supabase
    .from('landline_prefixes')
    .delete()
    .eq('prefix_id', prefixId)
    .select('prefix_id')

  if (error) throw error
  if (!data || data.length === 0) throw new Error(`No landline prefix found with ID: ${prefixId}`)
  return true
}

export { findAll, findById, create, update, remove }