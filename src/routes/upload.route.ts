import { Router }                   from 'express'
import { authenticate, authorize }  from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }     from '../middlewares/rateLimit.middleware.js'
import { uploadDocuments }          from '../middlewares/uploadDocuments.middleware.js'
import { uploadBookingDocuments } from '../controllers/admin/uploadDocument.controller.js'

const router = Router()

router.post(
  '/booking-documents',
  authenticate,
  authenticatedLimiter,
  authorize('client'),
  (req, res, next) => {
    uploadDocuments(req, res, (err) => {
      if (err) {
        return res.status(400).json({ status: 'error', message: err.message })
      }
      next()
    })
  },
  uploadBookingDocuments,
)

export default router