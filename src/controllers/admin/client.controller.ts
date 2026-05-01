import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as ClientService from '../../services/admin/client.service.js'

export async function getAllClients(req: Request, res: Response) {
  try {
    const data = await ClientService.getAllClient()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getClientById(req: Request, res: Response) {
  try {
    const data = await ClientService.getClientById(param(req.params.id))
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Client not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createClient(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await ClientService.createClient(req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateClient(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await ClientService.updateClient(param(req.params.id), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteClient(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    await ClientService.deleteClient(param(req.params.id), userId, ip)
    res.status(200).json({ status: 'success', message: 'Client deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}