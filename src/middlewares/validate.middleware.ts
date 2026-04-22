import { Request, Response, NextFunction } from 'express'
import { ZodSchema } from 'zod'

export const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body)
  if (!result.success) {
    res.status(400).json({
      status:  'error',
      message: 'Validation failed',
      errors:  result.error.issues.map(issue => ({
        field:   issue.path.join('.'),
        message: issue.message,
      })),
    })
    return
  }
  req.body = result.data
  next()
}