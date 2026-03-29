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


// import { Router } from 'express'
// import { validate }                from '../middlewares/validate.middleware.js'
// import { authenticate, authorize } from '../middlewares/auth.middleware.js'
// import { createAdminSchema, updateAdminSchema }                 from '../schema/admin/admin.schema.js'
// import { createClientSchema, updateClientSchema }               from '../schema/admin/client.schema.js'
// import { createDriverSchema, updateDriverSchema }               from '../schema/admin/driver.schema.js'
// import { createHelperSchema, updateHelperSchema }               from '../schema/admin/helper.schema.js'
// import { createTruckSchema, updateTruckSchema }                 from '../schema/admin/truck.schema.js'
// import { createTruckModelSchema, updateTruckModelSchema }       from '../schema/admin/truck-model.schema.js'
// import { createSubcontractorSchema, updateSubcontractorSchema } from '../schema/admin/subcontractor.schema.js'
// import * as AdminController         from '../controllers/admin/admin.controller.js'
// import * as ClientController        from '../controllers/admin/client.controller.js'
// import * as DriverController        from '../controllers/admin/driver.controller.js'
// import * as HelperController        from '../controllers/admin/helper.controller.js'
// import * as SubcontractorController from '../controllers/admin/subcontractor.controller.js'
// import * as TruckController         from '../controllers/admin/truck.controller.js'
// import * as TruckModelController    from '../controllers/admin/truck-model.controller.js'

// const router = Router()

// const isAdmin      = authorize('admin', 'super_admin')
// const isSuperAdmin = authorize('super_admin')

// router.get('/admins',        authenticate, isAdmin,      AdminController.getAllAdmins)
// router.get('/admins/:id',    authenticate, isAdmin,      AdminController.getAdminById)
// router.post('/admins',       authenticate, isSuperAdmin, validate(createAdminSchema), AdminController.createAdmin)
// router.patch('/admins/:id',  authenticate, isSuperAdmin, validate(updateAdminSchema), AdminController.updateAdmin)
// router.delete('/admins/:id', authenticate, isSuperAdmin, AdminController.deleteAdmin)

// router.get('/clients',        authenticate, isAdmin, ClientController.getAllClients)
// router.get('/clients/:id',    authenticate, isAdmin, ClientController.getClientById)
// router.post('/clients',       validate(createClientSchema), ClientController.createClient)
// router.patch('/clients/:id',  authenticate, isAdmin, validate(updateClientSchema), ClientController.updateClient)
// router.delete('/clients/:id', authenticate, isAdmin, ClientController.deleteClient)

// router.get('/drivers',        authenticate, isAdmin, DriverController.getAllDrivers)
// router.get('/drivers/:id',    authenticate, isAdmin, DriverController.getDriverById)
// router.post('/drivers',       isAdmin, validate(createDriverSchema), DriverController.createDriver)
// router.patch('/drivers/:id',  authenticate, isAdmin, validate(updateDriverSchema), DriverController.updateDriver)
// router.delete('/drivers/:id', authenticate, isAdmin, DriverController.deleteDriver)

// router.get('/helpers',        authenticate, isAdmin, HelperController.getAllHelpers)
// router.get('/helpers/:id',    authenticate, isAdmin, HelperController.getHelperById)
// router.post('/helpers',       authenticate, isAdmin, validate(createHelperSchema), HelperController.createHelper)
// router.patch('/helpers/:id',  authenticate, isAdmin, validate(updateHelperSchema), HelperController.updateHelper)
// router.delete('/helpers/:id', authenticate, isAdmin, HelperController.deleteHelper)

// router.get('/subcontractors',        authenticate, isAdmin, SubcontractorController.getAllSubcontractors)
// router.get('/subcontractors/:id',    authenticate, isAdmin, SubcontractorController.getSubcontractorById)
// router.post('/subcontractors',       authenticate, isAdmin, validate(createSubcontractorSchema), SubcontractorController.createSubcontractor)
// router.patch('/subcontractors/:id',  authenticate, isAdmin, validate(updateSubcontractorSchema), SubcontractorController.updateSubcontractor)
// router.delete('/subcontractors/:id', authenticate, isAdmin, SubcontractorController.deleteSubcontractor)

// router.get('/trucks',        authenticate, isAdmin, TruckController.getAllTrucks)
// router.get('/trucks/:id',    authenticate, isAdmin, TruckController.getTruckById)
// router.post('/trucks',       authenticate, isAdmin, validate(createTruckSchema), TruckController.createTruck)
// router.patch('/trucks/:id',  authenticate, isAdmin, validate(updateTruckSchema), TruckController.updateTruck)
// router.delete('/trucks/:id', authenticate, isAdmin, TruckController.deleteTruck)

// router.get('/truck-models',        authenticate, isAdmin, TruckModelController.getAllTruckModels)
// router.get('/truck-models/:id',    authenticate, isAdmin, TruckModelController.getTruckModelById)
// router.post('/truck-models',       authenticate, isAdmin, validate(createTruckModelSchema), TruckModelController.createTruckModel)
// router.patch('/truck-models/:id',  authenticate, isAdmin, validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
// router.delete('/truck-models/:id', authenticate, isAdmin, TruckModelController.deleteTruckModel)

// export default router