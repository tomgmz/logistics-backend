import { Router }                   from 'express'
import { authenticate, authorize }  from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }     from '../middlewares/rateLimit.middleware.js'
import { uploadDocuments }          from '../middlewares/uploadDocuments.middleware.js'
import { uploadBookingDocuments } from '../controllers/admin/uploadDocument.controller.js'

const router = Router()

// multer reports a rejected file type or an oversized upload through `err`;
// surfacing it as a 400 keeps the caller from seeing a generic 500.
const handleUpload = (req: any, res: any, next: any) => {
  uploadDocuments(req, res, (err: unknown) => {
    if (err) {
      return res.status(400).json({ status: 'error', message: (err as Error).message })
    }
    next()
  })
}

router.post(
  '/booking-documents',
  authenticate,
  authenticatedLimiter,
  authorize('client'),
  handleUpload,
  uploadBookingDocuments,
)


export default router