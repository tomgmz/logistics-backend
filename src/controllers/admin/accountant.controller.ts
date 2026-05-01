import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as AccountantService from '../../services/admin/accountant.service.js'

export async function getAllAccountants(req: Request, res: Response) {
  try {
    const data = await AccountantService.getAllAccountants()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function getAccountantById(req: Request, res: Response) {
  try {
    const data = await AccountantService.getAccountantById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = error.message === 'Accountant not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function createAccountant(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AccountantService.createAccountant(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateAccountant(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AccountantService.updateAccountant(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function deleteAccountant(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await AccountantService.deleteAccountant(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Accountant deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}