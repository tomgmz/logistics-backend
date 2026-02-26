import { Router } from 'express'
import { validate } from '../../middlewares/validate.middleware.js'
import { createClientSchema, updateClientSchema } from '../../schema/admin/client.schema.js'
import * as ClientController from '../../controllers/admin/client.controller.js'

const router = Router()

/**
 * @swagger
 * /clients:
 *   get:
 *     tags: [Clients]
 *     summary: Get all clients
 *     responses:
 *       200: { description: List of clients }
 *       500: { description: Internal server error }
 */
router.get('/', ClientController.getAllClients)

/**
 * @swagger
 * /clients/{id}:
 *   get:
 *     tags: [Clients]
 *     summary: Get clients by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Client found }
 *       404: { description: Client not found }
 *       500: { description: Internal server error }
 */
router.get('/:id', ClientController.getClientById)

/**
 * @swagger
 * /clients:
 *   post:
 *     tags: [Clients]
 *     summary: Create a new client
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateClientRequest'
 *           example:
 *             first_name: Juan
 *             last_name: dela Cruz
 *             username: juandc
 *             email: juan@example.com
 *             password: secret12345
 *     responses:
 *       201: { description: Client created successfully }
 *       400: { description: Validation error }
 *       500: { description: Internal server error }
 */
router.post('/', validate(createClientSchema), ClientController.createClient)

/**
 * @swagger
 * /clients/{id}:
 *   patch:
 *     tags: [Clients]
 *     summary: Update a client
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
router.patch('/:id', validate(updateClientSchema), ClientController.updateClient)

/**
 * @swagger
 * /clients/{id}:
 *   delete:
 *     tags: [Clients]
 *     summary: Delete a client
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Client deleted successfully }
 *       500: { description: Internal server error }
 */
router.delete('/:id', ClientController.deleteClient)

export default router