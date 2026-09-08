import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodIssue } from 'zod'

/**
 * Turn zod's issue list into one sentence a person can act on.
 *
 * `message` used to be the constant 'Validation failed' with the detail tucked
 * into `errors`, which every client in both apps ignores — they read
 * `response.data.message` and show it. So a booking rejected for a missing
 * transaction document told the user only that something, somewhere, was
 * invalid. The structured list is still returned for anything that wants to
 * highlight individual fields; this just stops the default path being a dead
 * end.
 */
function summarise(issues: ZodIssue[]): string {
  const parts = issues.slice(0, 3).map((issue) => {
    const field = issue.path.join('.')
    return field ? `${field}: ${issue.message}` : issue.message
  })
  const more = issues.length - parts.length
  return parts.join('; ') + (more > 0 ? ` (and ${more} more)` : '')
}

export const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body)
  if (!result.success) {
    res.status(400).json({
      status:  'error',
      message: summarise(result.error.issues),
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
