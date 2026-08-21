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

export async function deactivateAccountant(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AccountantService.deactivateAccountant(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Accountant deactivated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
                 : error.message.includes('already')   ? 409
                 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function activateAccountant(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AccountantService.activateAccountant(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Accountant activated', data })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404
                 : error.message.includes('already')   ? 409
                 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}
// Appoint or stand down this accountant as the GM's booking-approval proxy.
export async function setAccountantGmProxy(req: Request, res: Response) {
  try {
    const { userId } = getRequestMeta(req)
    const isProxy = req.body?.is_gm_proxy === true
    const data = await AccountantService.setGmProxy(param(req.params.id), isProxy, userId)
    res.status(200).json({
      status:  'success',
      message: isProxy ? 'Appointed as GM approval proxy' : 'Stood down as GM approval proxy',
      data,
    })
  } catch (error: any) {
    const status = error.message.includes('not found') ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}
