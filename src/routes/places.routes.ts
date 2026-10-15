import { Router } from 'express'
import { authenticate }         from '../middlewares/auth.middleware.js'
import { authenticatedLimiter } from '../middlewares/rateLimit.middleware.js'
import { validate }             from '../middlewares/validate.middleware.js'
import { placesAutocompleteSchema, placeDetailsSchema } from '../schema/maps/places.schema.js'
import { autocomplete, details } from '../controllers/maps/places.controller.js'

const router = Router()

// Both are POST so the session token and search text stay out of URLs and logs.
router.post('/autocomplete', authenticate, authenticatedLimiter, validate(placesAutocompleteSchema), autocomplete)
router.post('/details',      authenticate, authenticatedLimiter, validate(placeDetailsSchema),       details)

export default router
