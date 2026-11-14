import { supabase } from '../../lib/supabase.js'
import { pool } from '../../lib/database.js'
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
  return withUsage('handling', data)
}

export async function findHandlingCodeById(id: string) {
  const { data, error } = await supabase
    .from('handling_codes')
    .select('*')
    .eq('handling_code_id', id)
    .maybeSingle()

  if (error) throw error
  return data ? (await withUsage('handling', [data], data.handling_code_id))[0] : data
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

/** Deletes only while no booking uses it; false = in use (checked in the same statement). */
export async function removeHandlingCode(id: string) {
  const { rowCount } = await pool.query(
    `DELETE FROM handling_codes h WHERE h.handling_code_id = $1
       AND NOT EXISTS (SELECT 1 FROM booking_cargo_items i WHERE i.shc_id = h.handling_code_id OR i.ashc_id = h.handling_code_id)`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

export async function findAllCommodities() {
  const { data, error } = await supabase
    .from('commodities')
    .select('*')
    .order('name', { ascending: true })

  if (error) throw error
  return withUsage('commodity', data)
}

export async function findCommodityById(id: string) {
  const { data, error } = await supabase
    .from('commodities')
    .select('*')
    .eq('commodity_id', id)
    .maybeSingle()

  if (error) throw error
  return data ? (await withUsage('commodity', [data], data.commodity_id))[0] : data
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

/** Deletes only while no booking and no product uses it; false = in use. */
export async function removeCommodity(id: string) {
  const { rowCount } = await pool.query(
    `DELETE FROM commodities c WHERE c.commodity_id = $1
       AND NOT EXISTS (SELECT 1 FROM booking_cargo_items i WHERE i.commodity_id = c.commodity_id)
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.commodity_id = c.commodity_id)`,
    [id],
  )
  return (rowCount ?? 0) > 0
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
  return withUsage('product', data)
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
  return data ? (await withUsage('product', [data], data.product_id))[0] : data
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

/** Deletes only while no booking uses it; false = in use. */
export async function removeProduct(id: string) {
  const { rowCount } = await pool.query(
    `DELETE FROM products p WHERE p.product_id = $1
       AND NOT EXISTS (SELECT 1 FROM booking_cargo_items i WHERE i.product_id = p.product_id)`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

// ── usage ──────────────────────────────────────────────────────────────────
// Past bookings link to these rows (booking_cargo_items, ON DELETE SET NULL)
// and read the name through the link, so an entry a booking uses is never
// deleted: it is made inactive instead (hidden from the booking form).

type CatalogKind = 'handling' | 'commodity' | 'product'

const BOOKING_USAGE_SQL: Record<CatalogKind, string> = {
  handling: `SELECT id, count(DISTINCT booking_id)::int AS n FROM (
               SELECT shc_id AS id, booking_id FROM booking_cargo_items WHERE shc_id IS NOT NULL
               UNION ALL
               SELECT ashc_id, booking_id FROM booking_cargo_items WHERE ashc_id IS NOT NULL
             ) u WHERE ($1::uuid IS NULL OR id = $1) GROUP BY id`,
  commodity: `SELECT commodity_id AS id, count(DISTINCT booking_id)::int AS n FROM booking_cargo_items
               WHERE commodity_id IS NOT NULL AND ($1::uuid IS NULL OR commodity_id = $1) GROUP BY 1`,
  product:   `SELECT product_id AS id, count(DISTINCT booking_id)::int AS n FROM booking_cargo_items
               WHERE product_id IS NOT NULL AND ($1::uuid IS NULL OR product_id = $1) GROUP BY 1`,
}

const ID_COL: Record<CatalogKind, string> = {
  handling: 'handling_code_id', commodity: 'commodity_id', product: 'product_id',
}

async function countsBy(sql: string, id?: string): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ id: string; n: number }>(sql, [id ?? null])
  return new Map(rows.map(r => [r.id, r.n]))
}

/** Adds booking_count (bookings using the entry) and, for commodities, product_count. */
async function withUsage<T extends Record<string, any>>(kind: CatalogKind, rows: T[] | null, id?: string) {
  const list = rows ?? []
  if (list.length === 0) return list
  const [bookings, products] = await Promise.all([
    countsBy(BOOKING_USAGE_SQL[kind], id),
    kind === 'commodity'
      ? countsBy(`SELECT commodity_id AS id, count(*)::int AS n FROM products
                   WHERE commodity_id IS NOT NULL AND ($1::uuid IS NULL OR commodity_id = $1) GROUP BY 1`, id)
      : Promise.resolve(null),
  ])
  return list.map(r => ({
    ...r,
    booking_count: bookings.get(r[ID_COL[kind]]) ?? 0,
    ...(products && { product_count: products.get(r[ID_COL[kind]]) ?? 0 }),
  }))
}
