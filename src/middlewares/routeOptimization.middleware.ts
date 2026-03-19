import { Request, Response, NextFunction } from 'express'

export function validateGoogleCredentials(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const required = [
    'GOOGLE_MAPS_API_KEY',
    'GOOGLE_PROJECT_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  ]

  const missing = required.filter((key) => !process.env[key])

  if (missing.length > 0) {
    return res.status(500).json({
      status: 'error',
      message: `Missing Google credentials: ${missing.join(', ')}`,
    })
  }

  next()
}