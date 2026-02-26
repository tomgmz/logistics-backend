import { Router } from 'express'
import { validate } from '../../middlewares/validate.middleware.js'
import { createHelperSchema, updateHelperSchema } from '../../schema/admin/helper.schema.js'
import * as HelperController from '../../controllers/admin/helper.controller.js'

const router = Router()

/**
 * @swagger
 * /helpers:
 *   get:
 *     tags: [Helpers]
 *     summary: Get all helpers
 *     responses:
 *       200:
 *         description: List of helpers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Helper' }
 *       500: { description: Internal server error }
 */
router.get('/', HelperController.getAllHelpers)

/**
 * @swagger
 * /helpers/{id}:
 *   get:
 *     tags: [Helpers]
 *     summary: Get helper by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: a1b2c3d4-e5f6-7890-abcd-ef0123456789
 *     responses:
 *       200:
 *         description: Helper found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data: { $ref: '#/components/schemas/Helper' }
 *       404: { description: Helper not found }
 *       500: { description: Internal server error }
 */
router.get('/:id', HelperController.getHelperById)

/**
 * @swagger
 * /helpers:
 *   post:
 *     tags: [Helpers]
 *     summary: Create a new helper
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateHelperRequest' }
 *           example:
 *             first_name: Carlo
 *             last_name: Mendoza
 *             middle_initial: null
 *             suffix: null
 *             username: carlomendoza
 *             email: carlo@example.com
 *             password: secret12345
 *             phone: "09201234567"
 *             license_number: N01-12-654321
 *             license_expiry: "2027-12-31"
 *             created_by: null
 *     responses:
 *       201:
 *         description: Helper created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data: { $ref: '#/components/schemas/Helper' }
 *       400: { description: Validation error }
 *       500: { description: Internal server error }
 */
router.post('/', validate(createHelperSchema), HelperController.createHelper)

/**
 * @swagger
 * /helpers/{id}:
 *   patch:
 *     tags: [Helpers]
 *     summary: Update a helper
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: a1b2c3d4-e5f6-7890-abcd-ef0123456789
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateHelperRequest' }
 *           example:
 *             first_name: Carlo
 *             last_name: Mendoza
 *             phone: "09201234567"
 *             license_number: N01-12-654321
 *             license_expiry: "2028-12-31"
 *             driver_status: available
 *     responses:
 *       200:
 *         description: Helper updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data: { $ref: '#/components/schemas/Helper' }
 *       400: { description: Validation error }
 *       404: { description: Helper not found }
 *       500: { description: Internal server error }
 */
router.patch('/:id', validate(updateHelperSchema), HelperController.updateHelper)

/**
 * @swagger
 * /helpers/{id}:
 *   delete:
 *     tags: [Helpers]
 *     summary: Delete a helper
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: a1b2c3d4-e5f6-7890-abcd-ef0123456789
 *     responses:
 *       200:
 *         description: Helper deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 message: { type: string, example: Helper deleted successfully }
 *       404: { description: Helper not found }
 *       500: { description: Internal server error }
 */
router.delete('/:id', HelperController.deleteHelper)

export default router