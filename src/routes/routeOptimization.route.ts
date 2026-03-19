import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { validateGoogleCredentials } from '../middlewares/routeOptimization.middleware.js'
import { optimizeRouteSchema, geocodeAddressSchema } from '../schema/maps/routeOptimization.schema.js'
import * as RouteOptimizationController from '../controllers/maps/routeOptimization.controller.js'

const router = Router()

router.use(validateGoogleCredentials)

router.post(
  '/optimize/:id',
  RouteOptimizationController.optimizeBookingRoute
)

router.post(
  '/geocode',
  validate(geocodeAddressSchema),
  RouteOptimizationController.geocodeAddress
)

export default router