import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { createAdminSchema, updateAdminSchema }               from '../schema/admin/admin.schema.js'
import { createClientSchema, updateClientSchema }             from '../schema/admin/client.schema.js'
import { createDriverSchema, updateDriverSchema }             from '../schema/admin/driver.schema.js'
import { createHelperSchema, updateHelperSchema }             from '../schema/admin/helper.schema.js'
import { createTruckSchema, updateTruckSchema }               from '../schema/admin/truck.schema.js'
import { createTruckModelSchema, updateTruckModelSchema }     from '../schema/admin/truck-model.schema.js'
import { createSubcontractorSchema, updateSubcontractorSchema } from '../schema/admin/subcontractor.schema.js'
import * as AdminController         from '../controllers/admin/admin.controller.js'
import * as ClientController        from '../controllers/admin/client.controller.js'
import * as DriverController        from '../controllers/admin/driver.controller.js'
import * as HelperController        from '../controllers/admin/helper.controller.js'
import * as SubcontractorController from '../controllers/admin/subcontractor.controller.js'
import * as TruckController         from '../controllers/admin/truck.controller.js'
import * as TruckModelController    from '../controllers/admin/truck-model.controller.js'

const router = Router()

// Admins
router.get('/admins',        AdminController.getAllAdmins)
router.get('/admins/:id',    AdminController.getAdminById)
router.post('/admins',       validate(createAdminSchema), AdminController.createAdmin)
router.patch('/admins/:id',  validate(updateAdminSchema), AdminController.updateAdmin)
router.delete('/admins/:id', AdminController.deleteAdmin)

// Clients
router.get('/clients',        ClientController.getAllClients)
router.get('/clients/:id',    ClientController.getClientById)
router.post('/clients',       validate(createClientSchema), ClientController.createClient)
router.patch('/clients/:id',  validate(updateClientSchema), ClientController.updateClient)
router.delete('/clients/:id', ClientController.deleteClient)

// Drivers
router.get('/drivers',        DriverController.getAllDrivers)
router.get('/drivers/:id',    DriverController.getDriverById)
router.post('/drivers',       validate(createDriverSchema), DriverController.createDriver)
router.patch('/drivers/:id',  validate(updateDriverSchema), DriverController.updateDriver)
router.delete('/drivers/:id', DriverController.deleteDriver)

// Helpers
router.get('/helpers',        HelperController.getAllHelpers)
router.get('/helpers/:id',    HelperController.getHelperById)
router.post('/helpers',       validate(createHelperSchema), HelperController.createHelper)
router.patch('/helpers/:id',  validate(updateHelperSchema), HelperController.updateHelper)
router.delete('/helpers/:id', HelperController.deleteHelper)

// Subcontractors
router.get('/subcontractors',        SubcontractorController.getAllSubcontractors)
router.get('/subcontractors/:id',    SubcontractorController.getSubcontractorById)
router.post('/subcontractors',       validate(createSubcontractorSchema), SubcontractorController.createSubcontractor)
router.patch('/subcontractors/:id',  validate(updateSubcontractorSchema), SubcontractorController.updateSubcontractor)
router.delete('/subcontractors/:id', SubcontractorController.deleteSubcontractor)

// Trucks
router.get('/trucks',        TruckController.getAllTrucks)
router.get('/trucks/:id',    TruckController.getTruckById)
router.post('/trucks',       validate(createTruckSchema), TruckController.createTruck)
router.patch('/trucks/:id',  validate(updateTruckSchema), TruckController.updateTruck)
router.delete('/trucks/:id', TruckController.deleteTruck)

// Truck Models
router.get('/truck-models',        TruckModelController.getAllTruckModels)
router.get('/truck-models/:id',    TruckModelController.getTruckModelById)
router.post('/truck-models',       validate(createTruckModelSchema), TruckModelController.createTruckModel)
router.patch('/truck-models/:id',  validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
router.delete('/truck-models/:id', TruckModelController.deleteTruckModel)

export default router