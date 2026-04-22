import { Router } from 'express'
import { authenticate }         from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { validate }             from '../middlewares/validate.middleware.js'
import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
import { computeDirectionsSchema }   from '../schema/maps/directions.schema.js'
import { computeDirections }         from '../controllers/maps/directions.controller.js'

const router = Router()

router.post(
  '/',
  authenticate,
  authenticatedLimiter,
  validateGoogleCredentials,
  validate(computeDirectionsSchema),
  computeDirections
)

export default router