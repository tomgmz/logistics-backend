import { Router } from 'express'
import { authenticate } from '../middlewares/auth.middleware.js'
import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
import { computeDirections } from '../controllers/maps/directions.controller.js'

const router = Router()

router.post('/', authenticate, validateGoogleCredentials, computeDirections)

export default router