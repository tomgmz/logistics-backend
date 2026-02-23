import { Request, Response } from 'express'
import * as ClientService from '../../services/admin/client.service.js'
import { stat } from 'node:fs'

export async function getAllClients(req: Request, res: Response){
    try {
        const data = await ClientService.getAllClient()
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function getClientById(req: Request, res: Response){
    try {
        const data = await ClientService.getClientById(req.params.id as string)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        const status = err.message === 'Client not found' ? 404 : 500
        res.status(status).json({ status: 'error', message: err.message })
    }
}

export async function createClient(req: Request, res: Response) {
    try {
        const data = await ClientService.createClient(req.body)
        res.status(201).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function updateClient(req: Request, res: Response) {
    try {
        const data = await ClientService.updateClient(req.params.id as string, req.body)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function deleteClient(req: Request, res: Response) {
  try {
    await ClientService.deleteClient(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Client deleted successfully' })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}
