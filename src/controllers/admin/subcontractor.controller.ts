import { Request, Response } from 'express'
import * as SubcontractorService from '../../services/admin/subcontractor.service.js'

export async function getAllSubcontractors(req: Request, res: Response) {
    try {
        const data = await SubcontractorService.getAllSubcontractor()
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function getSubcontractorById(req: Request, res: Response) {
    try {
        const data = await SubcontractorService.getAdminById(req.params.id as string)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        const status = err.message === 'Subcontractor not found' ? 404 : 500
        res.status(status).json({ status: 'error', message: err.message })
    }
}

export async function createSubcontractor(req: Request, res: Response) {
    try {
        const data = await SubcontractorService.createSubcontractor(req.body)
        res.status(200).json({ status: 'success', data })
    } catch (err:any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function updateSubcontractor(req: Request, res: Response){
    try {
        const data = await SubcontractorService.updateSubcontractor(req.params.id as string, req.body)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function deleteSubcontractor(req: Request, res: Response) {
    try {
        await SubcontractorService.deleteSubcontractor(req.params.id as string)
        res.status(200).json({ status: 'success', message: 'Subcontractor deleted successfully' })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}