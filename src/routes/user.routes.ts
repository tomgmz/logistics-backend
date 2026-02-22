import { Router } from 'express'
import { createUserController } from '../controllers/user.controller.js'
import { validate } from '../middlewares/validate.middleware.js'
import { createUserSchema } from '../schema/user.schema.js'

const router = Router()

router.post('/createUser', validate(createUserSchema), createUserController)

export default router