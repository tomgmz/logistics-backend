import { Router } from 'express'
import { validate } from '../../middlewares/validate.middleware.js'
import { createAdminSchema, updateAdminSchema } from '../../schema/admin/admin.client.js'
import * as AdminController from '../../controllers/admin/admin.controller.js'

const router = Router()

/**
 * @swagger
 * /admin:
 *   get:
 *     tags: [Admins]
 *     summary: Get all admins
 *     responses:
 *       200: { description: List of admins }
 *       500: { description: Internal server error }
 */
router.get('/', AdminController.getAllAdmins)

/**
 * @swagger
 * /admin/{id}:
 *   get:
 *     tags: [Admins]
 *     summary: Get admin by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Admin found }
 *       404: { description: Admin not found }
 *       500: { description: Internal server error }
 */
router.get('/:id', AdminController.getAdminById)

/**
 * @swagger
 * /admin:
 *   post:
 *     tags: [Admins]
 *     summary: Create a new admin
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAdminRequest'
 *           example:
 *             first_name: John
 *             last_name: Doe
 *             username: johndoe
 *             email: john@example.com
 *             password: secret12345
 *             role: admin
 *     responses:
 *       201: { description: Admin created successfully }
 *       400: { description: Validation error }
 *       500: { description: Internal server error }
 */
router.post('/', validate(createAdminSchema), AdminController.createAdmin)

/**
 * @swagger
 * /admin/{id}:
 *   post:
 *     tags: [Admins]
 *     summary: Update an admin
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
 *             $ref: '#/components/schemas/UpdateAdminRequest'
 *           example:
 *             first_name: John
 *             last_name: Doe
 *             username: johndoe
 *             email: john@example.com
 *     responses:
 *       200: { description: Admin updated successfully }
 *       400: { description: Validation error }
 *       500: { description: Internal server error }
 */
router.post('/:id', validate(updateAdminSchema), AdminController.updateAdmin)

/**
 * @swagger
 * /admin/{id}:
 *   delete:
 *     tags: [Admins]
 *     summary: Delete an admin
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Admin deleted successfully }
 *       404: { description: Admin not found }
 *       500: { description: Internal server error }
 */
router.delete('/:id', AdminController.deleteAdmin)

export default router