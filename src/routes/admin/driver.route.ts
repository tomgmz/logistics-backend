import { Router } from 'express'
import { validate } from '../../middlewares/validate.middleware.js'
import { createDriverSchema, updateDriverSchema } from '../../schema/admin/driver.schema.js'
import * as DriverController from '../../controllers/admin/driver.controller.js'

const router = Router()

/**
 * @swagger
 * /drivers:
 *   get:
 *     tags: [Drivers]
 *     summary: Get all drivers
 *     responses:
 *       200: { description: List of drivers }
 *       500: { description: Internal server error }
 */
router.get('/', DriverController.getAllDrivers)

/**
 * @swagger
 * /drivers/{id}:
 *   get:
 *     tags: [Drivers]
 *     summary: Get driver by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Driver found }
 *       404: { description: Driver not found }
 *       500: { description: Internal server error }
 */
router.get('/:id', DriverController.getDriverById)

/**
 * @swagger
 * /drivers:
 *   post:
 *     tags: [Drivers]
 *     summary: Create a new driver
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateDriverRequest'
 *           example:
 *             first_name: Juan
 *             last_name: dela Cruz
 *             username: juandc
 *             email: juan@example.com
 *             password: secret12345
 *             license_number: N01-12-123456
 *             license_expiry: "2027-12-31"
 *             is_subcontractor_driver: false
 *     responses:
 *       201: { description: Driver created successfully }
 *       400: { description: Validation error }
 *       500: { description: Internal server error }
 */
router.post('/', validate(createDriverSchema), DriverController.createDriver)

/**
 * @swagger
 * /drivers/{id}:
 *   patch:
 *     tags: [Drivers]
 *     summary: Update a driver
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateDriverRequest'
 *           example:
 *             first_name: Juan
 *             license_number: N01-12-999999
 *             license_expiry: "2028-12-31"
 *     responses:
 *       200: { description: Driver updated successfully }
 *       400: { description: Validation error }
 *       500: { description: Internal server error }
 */
router.patch('/:id', validate(updateDriverSchema), DriverController.updateDriver)

/**
 * @swagger
 * /drivers/{id}:
 *   delete:
 *     tags: [Drivers]
 *     summary: Delete a driver
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Driver deleted successfully }
 *       500: { description: Internal server error }
 */
router.delete('/:id', DriverController.deleteDriver)

export default router