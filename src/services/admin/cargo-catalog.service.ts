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

export async function getAllHandlingCodes(type?: 'standard' | 'additional') {
  return CargoCatalogModel.findAllHandlingCodes(type)
}

export async function getHandlingCodeById(id: string) {
  const hc = await CargoCatalogModel.findHandlingCodeById(id)
  if (!hc) throw new Error('Handling code not found')
  return hc
}

export async function createHandlingCode(input: CreateHandlingCodeInput, actorId?: string | null, ip?: string | null) {
  const result = await CargoCatalogModel.createHandlingCode(input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'handling_code_created',
    description: `Handling code ${input.code} (${input.type ?? 'standard'}) created`,

  })

  return result
}

export async function updateHandlingCode(id: string, input: UpdateHandlingCodeInput, actorId?: string | null, ip?: string | null) {
  await getHandlingCodeById(id)
  const result = await CargoCatalogModel.updateHandlingCode(id, input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'handling_code_updated',
    description: `Handling code ${id} updated`,

  })

  return result
}

export async function deleteHandlingCode(id: string, actorId?: string | null, ip?: string | null) {
  await getHandlingCodeById(id)
  await CargoCatalogModel.removeHandlingCode(id)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'handling_code_deleted',
    description: `Handling code ${id} deleted`,

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

export async function createCommodity(input: CreateCommodityInput, actorId?: string | null, ip?: string | null) {
  const result = await CargoCatalogModel.createCommodity(input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'commodity_created',
    description: `Commodity "${input.name}" created`,

  })

  return result
}

export async function updateCommodity(id: string, input: UpdateCommodityInput, actorId?: string | null, ip?: string | null) {
  await getCommodityById(id)
  const result = await CargoCatalogModel.updateCommodity(id, input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'commodity_updated',
    description: `Commodity ${id} updated`,

  })

  return result
}

export async function deleteCommodity(id: string, actorId?: string | null, ip?: string | null) {
  await getCommodityById(id)
  await CargoCatalogModel.removeCommodity(id)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'commodity_deleted',
    description: `Commodity ${id} deleted`,

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

export async function createProduct(input: CreateProductInput, actorId?: string | null, ip?: string | null) {
  const result = await CargoCatalogModel.createProduct(input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'product_created',
    description: `Product "${input.name}" created`,

  })

  return result
}

export async function updateProduct(id: string, input: UpdateProductInput, actorId?: string | null, ip?: string | null) {
  await getProductById(id)
  const result = await CargoCatalogModel.updateProduct(id, input)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'product_updated',
    description: `Product ${id} updated`,

  })

  return result
}

export async function deleteProduct(id: string, actorId?: string | null, ip?: string | null) {
  await getProductById(id)
  await CargoCatalogModel.removeProduct(id)

  logEvent({
    user_id:     actorId,
    log_type:    'admin_activity',
    action:      'product_deleted',
    description: `Product ${id} deleted`,

  })

  return true
}
