import { Request, Response } from 'express'
import { createUserService } from '../services/user.service.js'
import { create } from 'node:domain'

export const createUserController = async (req: Request, res: Response) => {
  try {
    const user = await createUserService(req.body)
    res.status(201).json({ status: 'success', data: user })
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message })
  }
}