import { Request, Response } from 'express'
import * as HelperService from '../../services/admin/helper.service.js'

export async function getAllHelpers(req: Request, res: Response) {
  try {
    const data = await HelperService.getAllHelpers()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getHelperById(req: Request, res: Response) {
  try {
    const data = await HelperService.getHelperById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Helper not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createHelper(req: Request, res: Response) {
  try {
    const data = await HelperService.createHelper(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateHelper(req: Request, res: Response) {
  try {
    const data = await HelperService.updateHelper(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteHelper(req: Request, res: Response) {
  try {
    await HelperService.deleteHelper(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Helper deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}