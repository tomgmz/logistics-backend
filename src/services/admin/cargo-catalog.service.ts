import * as CargoCatalogModel from '../../models/admin/cargo-catalog.model.js'
import { logEvent } from '../../lib/log-event.js'
import {
  CreateHandlingCodeInput,
  UpdateHandlingCodeInput,
  CreateCommodityInput,
  UpdateCommodityInput,
  CreateProductInput,
  UpdateProductInput,
} from '../../types/cargo-catalog.types.js'

// Codes and commodity names are unique, ignoring case and outer spaces. Checked
// here, not by a DB index, because production already holds duplicates
// (HAZ ×3, Electronics ×2) that have to be merged by hand first.
function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409 })
}
const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase()

async function assertUniqueCode(code: string | undefined, exceptId?: string) {
  if (code === undefined) return
  const all = await CargoCatalogModel.findAllHandlingCodes()
  const hit = (all ?? []).find((h: any) => norm(h.code) === norm(code) && h.handling_code_id !== exceptId)
  if (hit) throw conflict(`Handling code ${hit.code} already exists`)
}

async function assertUniqueCommodity(name: string | undefined, exceptId?: string) {
  if (name === undefined) return
  const all = await CargoCatalogModel.findAllCommodities()
  const hit = (all ?? []).find((c: any) => norm(c.name) === norm(name) && c.commodity_id !== exceptId)
  if (hit) throw conflict(`Commodity "${hit.name}" already exists`)
}

export async function getAllHandlingCodes(type?: 'standard' | 'additional') {
  return CargoCatalogModel.findAllHandlingCodes(type)
}

export async function getHandlingCodeById(id: string) {
  const hc = await CargoCatalogModel.findHandlingCodeById(id)
  if (!hc) throw new Error('Handling code not found')
  return hc
}

export async function createHandlingCode(input: CreateHandlingCodeInput, actorId?: string | null) {
  await assertUniqueCode(input.code)
  const result = await CargoCatalogModel.createHandlingCode(input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'handling_code_created',
    description: `Handling code ${input.code} created`,

  })

  return result
}

export async function updateHandlingCode(id: string, input: UpdateHandlingCodeInput, actorId?: string | null) {
  await getHandlingCodeById(id)
  await assertUniqueCode(input.code, id)
  const result = await CargoCatalogModel.updateHandlingCode(id, input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'handling_code_updated',
    description: `Handling code ${result?.code ?? id} updated`,

  })

  return result
}

const bookingsText = (n: number) => `${n} booking${n === 1 ? '' : 's'}`

/**
 * Delete an entry no booking uses. Past bookings read the name through the
 * link, so one that is in use is refused and made inactive instead (hidden
 * from the booking form, past bookings untouched), as vehicle types are.
 */
export async function deleteHandlingCode(id: string, actorId?: string | null) {
  const hc: any = await getHandlingCodeById(id)
  if (!(await CargoCatalogModel.removeHandlingCode(id))) {
    const n = (await getHandlingCodeById(id) as any).booking_count ?? 0
    throw conflict(`${hc.code} is used on ${bookingsText(n)}, so it can't be deleted. Make it inactive to hide it from the booking form.`)
  }

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'handling_code_deleted',
    description: `Handling code ${hc.code} deleted`,

  })

  return true
}

export async function getAllCommodities() {
  return CargoCatalogModel.findAllCommodities()
}

export async function getCommodityById(id: string) {
  const commodity = await CargoCatalogModel.findCommodityById(id)
  if (!commodity) throw new Error('Commodity not found')
  return commodity
}

export async function createCommodity(input: CreateCommodityInput, actorId?: string | null) {
  await assertUniqueCommodity(input.name)
  const result = await CargoCatalogModel.createCommodity(input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'commodity_created',
    description: `Commodity "${input.name}" created`,

  })

  return result
}

export async function updateCommodity(id: string, input: UpdateCommodityInput, actorId?: string | null) {
  await getCommodityById(id)
  await assertUniqueCommodity(input.name, id)
  const result = await CargoCatalogModel.updateCommodity(id, input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'commodity_updated',
    description: `Commodity ${result?.name ?? id} updated`,

  })

  return result
}

export async function deleteCommodity(id: string, actorId?: string | null) {
  const c: any = await getCommodityById(id)
  if (!(await CargoCatalogModel.removeCommodity(id))) {
    const now: any = await getCommodityById(id)
    const uses = [
      now.booking_count ? bookingsText(now.booking_count) : '',
      now.product_count ? `${now.product_count} product${now.product_count === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ')
    throw conflict(`${c.name} is used on ${uses || 'a booking'}, so it can't be deleted. Make it inactive to hide it from the booking form.`)
  }

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'commodity_deleted',
    description: `Commodity ${c.name} deleted`,

  })

  return true
}

export async function getAllProducts(commodityId?: string) {
  return CargoCatalogModel.findAllProducts(commodityId)
}

export async function getProductById(id: string) {
  const product = await CargoCatalogModel.findProductById(id)
  if (!product) throw new Error('Product not found')
  return product
}

export async function createProduct(input: CreateProductInput, actorId?: string | null) {
  const result = await CargoCatalogModel.createProduct(input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'product_created',
    description: `Product "${input.name}" created`,

  })

  return result
}

export async function updateProduct(id: string, input: UpdateProductInput, actorId?: string | null) {
  await getProductById(id)
  const result = await CargoCatalogModel.updateProduct(id, input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'product_updated',
    description: `Product ${result?.name ?? id} updated`,

  })

  return result
}

export async function deleteProduct(id: string, actorId?: string | null) {
  const pr: any = await getProductById(id)
  if (!(await CargoCatalogModel.removeProduct(id))) {
    const n = (await getProductById(id) as any).booking_count ?? 0
    throw conflict(`${pr.name} is used on ${bookingsText(n)}, so it can't be deleted. Make it inactive to hide it from the booking form.`)
  }

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'product_deleted',
    description: `Product ${pr.name} deleted`,

  })

  return true
}
