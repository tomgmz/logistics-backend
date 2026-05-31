import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as CargoCatalogService from '../../services/admin/cargo-catalog.service.js'

export async function getAllHandlingCodes(req: Request, res: Response) {
  try {
    const type = req.query.type as 'standard' | 'additional' | undefined
    const data = await CargoCatalogService.getAllHandlingCodes(type)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getHandlingCodeById(req: Request, res: Response) {
  try {
    const data = await CargoCatalogService.getHandlingCodeById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Handling code not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createHandlingCode(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await CargoCatalogService.createHandlingCode(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateHandlingCode(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await CargoCatalogService.updateHandlingCode(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Handling code not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function deleteHandlingCode(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await CargoCatalogService.deleteHandlingCode(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Handling code deleted successfully' })
  } catch (error: any) {
    const status = error.message === 'Handling code not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function getAllCommodities(req: Request, res: Response) {
  try {
    const data = await CargoCatalogService.getAllCommodities()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getCommodityById(req: Request, res: Response) {
  try {
    const data = await CargoCatalogService.getCommodityById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Commodity not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createCommodity(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await CargoCatalogService.createCommodity(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateCommodity(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await CargoCatalogService.updateCommodity(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Commodity not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function deleteCommodity(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await CargoCatalogService.deleteCommodity(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Commodity deleted successfully' })
  } catch (error: any) {
    const status = error.message === 'Commodity not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function getAllProducts(req: Request, res: Response) {
  try {
    const commodityId = req.query.commodity_id as string | undefined
    const data = await CargoCatalogService.getAllProducts(commodityId)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getProductById(req: Request, res: Response) {
  try {
    const data = await CargoCatalogService.getProductById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Product not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createProduct(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await CargoCatalogService.createProduct(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateProduct(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await CargoCatalogService.updateProduct(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Product not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function deleteProduct(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await CargoCatalogService.deleteProduct(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Product deleted successfully' })
  } catch (error: any) {
    const status = error.message === 'Product not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}