import { Request, Response } from 'express'
import * as AdminService from '../../services/admin/admin.service.js'

export async function getAllAdmins(req: Request, res: Response) {
    try {
        const data = await AdminService.getAllAdmin()
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error' , message: err.message })
    }
}

export async function getAdminById(req: Request, res: Response) {
    try {
        const data = await AdminService.getAdminById(req.params.id as string)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        const status = err.message === 'Admin not found' ? 404 : 500
        res.status(status).json({ status: 'error', message: err.message })
    }
}

export async function createAdmin(req: Request, res: Response) {
    try {
        const data = await AdminService.createAdmin(req.body)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function updateAdmin(req: Request, res: Response) {
    try {
        const data = await AdminService.updateAdmin(req.params.id as string, req.body)
        res.status(200).json({ status: 'success', data })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}

export async function deleteAdmin(req: Request, res: Response) {
    try {
        await AdminService.deleteAdmin(req.params.id as string)
        res.status(200).json({ status: 'success', message: 'Admin deleted successfully' })
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message })
    }
}