import { Request, Response, NextFunction } from 'express'
import { ZodTypeAny } from 'zod'

export const validate = (schema: ZodTypeAny) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const flattened = result.error.flatten()
      return res.status(400).json({ success: false, errors: flattened.fieldErrors })
    }
    req.body = result.data
    next()
  }
}