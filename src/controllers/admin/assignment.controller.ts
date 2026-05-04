import { Request, Response } from 'express'
import { getRequestMeta, param } from '../../lib/controller-utils.js'
import * as AssignmentService from '../../services/admin/assignment.service.js'

export async function assignBooking(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AssignmentService.assignBookingService(param(req.params.bookingId), req.body, userId, ip)
    res.status(201).json({ status: 'success', data })
  } catch (error: any) {
    const status = /not found/i.test(error.message) ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function getAssignmentByBooking(req: Request, res: Response) {
  try {
    const data = await AssignmentService.getAssignmentByBookingService(param(req.params.bookingId))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = /not found|no assignment/i.test(error.message) ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function getAllAssignments(_req: Request, res: Response) {
  try {
    const data = await AssignmentService.getAllAssignmentsService()
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message })
  }
}

export async function updateDeliveryStatus(req: Request, res: Response) {
  try {
    const { userId, ip } = getRequestMeta(req)
    const data = await AssignmentService.updateDeliveryStatusService(param(req.params.bookingId), req.body, userId, ip)
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = /not found|no delivery/i.test(error.message) ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}

export async function getAssignmentHistory(req: Request, res: Response) {
  try {
    const data = await AssignmentService.getAssignmentHistoryService(param(req.params.bookingId))
    res.status(200).json({ status: 'success', data })
  } catch (error: any) {
    const status = /not found/i.test(error.message) ? 404 : 500
    res.status(status).json({ status: 'error', message: error.message })
  }
}
