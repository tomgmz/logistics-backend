import { Request, Response } from 'express'
import * as AssistantDriverService from '../../services/admin/assistant_driver.service.js'

export async function getAllAssistantDrivers(req: Request, res: Response) {
  try {
    const data = await AssistantDriverService.getAllAssistantDrivers()
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function getAssistantDriverById(req: Request, res: Response) {
  try {
    const data = await AssistantDriverService.getAssistantDriverById(req.params.id as string)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    const status = err.message === 'Assistant Driver not found' ? 404 : 500
    res.status(status).json({ status: 'error', message: err.message })
  }
}

export async function createAssistantDriver(req: Request, res: Response) {
  try {
    const data = await AssistantDriverService.createAssistantDriver(req.body)
    res.status(201).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function updateAssistantDriver(req: Request, res: Response) {
  try {
    const data = await AssistantDriverService.updateAssistantDriver(req.params.id as string, req.body)
    res.status(200).json({ status: 'success', data })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}

export async function deleteAssistantDriver(req: Request, res: Response) {
  try {
    await AssistantDriverService.deleteAssistantDriver(req.params.id as string)
    res.status(200).json({ status: 'success', message: 'Assistant Driver deleted successfully' })
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message })
  }
}