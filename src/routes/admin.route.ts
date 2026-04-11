import { Router } from 'express'
import { validate } from '../middlewares/validate.middleware.js'
import { createAdminSchema, updateAdminSchema }               from '../schema/admin/admin.schema.js'
import { createClientSchema, updateClientSchema }             from '../schema/admin/client.schema.js'
import { createDriverSchema, updateDriverSchema }             from '../schema/admin/driver.schema.js'
import { createAssistantDriverSchema, updateAssistantDriverSchema } from '../schema/admin/assistant_driver.schema.js'
import { createTruckSchema, updateTruckSchema }               from '../schema/admin/truck.schema.js'
import { createTruckModelSchema, updateTruckModelSchema }     from '../schema/admin/truck-model.schema.js'
import { createVendorSchema, updateVendorSchema }             from '../schema/admin/vendor.schema.js'
import { createAccountantSchema, updateAccountantSchema }     from '../schema/admin/accountant.schema.js'
import { createGeneralManagerSchema, updateGeneralManagerSchema } from '../schema/admin/general_manager.schema.js'
import * as AdminController         from '../controllers/admin/admin.controller.js'
import * as ClientController        from '../controllers/admin/client.controller.js'
import * as DriverController        from '../controllers/admin/driver.controller.js'
import * as AssistantDriverController from '../controllers/admin/assistant_driver.controller.js'
import * as VendorController        from '../controllers/admin/vendor.controller.js'
import * as TruckController         from '../controllers/admin/truck.controller.js'
import * as TruckModelController    from '../controllers/admin/truck-model.controller.js'
import * as AccountantController    from '../controllers/admin/accountant.controller.js'
import * as GeneralManagerController from '../controllers/admin/general_manager.controller.js'

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

// Assistant Drivers
router.get('/assistant_drivers',        AssistantDriverController.getAllAssistantDrivers)
router.get('/assistant_drivers/:id',    AssistantDriverController.getAssistantDriverById)
router.post('/assistant_drivers',       validate(createAssistantDriverSchema), AssistantDriverController.createAssistantDriver)
router.patch('/assistant_drivers/:id',  validate(updateAssistantDriverSchema), AssistantDriverController.updateAssistantDriver)
router.delete('/assistant_drivers/:id', AssistantDriverController.deleteAssistantDriver)

// Vendors
router.get('/vendors',        VendorController.getAllVendors)
router.get('/vendors/:id',    VendorController.getVendorById)
router.post('/vendors',       validate(createVendorSchema), VendorController.createVendor)
router.patch('/vendors/:id',  validate(updateVendorSchema), VendorController.updateVendor)
router.delete('/vendors/:id', VendorController.deleteVendor)

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

// Accountants
router.get('/accountants',        AccountantController.getAllAccountants)
router.get('/accountants/:id',    AccountantController.getAccountantById)
router.post('/accountants',       validate(createAccountantSchema), AccountantController.createAccountant)
router.patch('/accountants/:id',  validate(updateAccountantSchema), AccountantController.updateAccountant)
router.delete('/accountants/:id', AccountantController.deleteAccountant)

// General Managers
router.get('/general-managers',        GeneralManagerController.getAllGeneralManagers)
router.get('/general-managers/:id',    GeneralManagerController.getGeneralManagerById)
router.post('/general-managers',       validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
router.patch('/general-managers/:id',  validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
router.delete('/general-managers/:id', GeneralManagerController.deleteGeneralManager)

export default router


// import { Router } from 'express'
// import { validate }                from '../middlewares/validate.middleware.js'
// import { authenticate, authorize } from '../middlewares/auth.middleware.js'
// import { createAdminSchema, updateAdminSchema }                 from '../schema/admin/admin.schema.js'
// import { createClientSchema, updateClientSchema }               from '../schema/admin/client.schema.js'
// import { createDriverSchema, updateDriverSchema }               from '../schema/admin/driver.schema.js'
// import { createAssistantDriverSchema, updateAssistantDriverSchema } from '../schema/admin/assistant_driver.schema.js'
// import { createTruckSchema, updateTruckSchema }                 from '../schema/admin/truck.schema.js'
// import { createTruckModelSchema, updateTruckModelSchema }       from '../schema/admin/truck-model.schema.js'
// import { createVendorSchema, updateVendorSchema } from '../schema/admin/vendor.schema.js'
// import * as AdminController         from '../controllers/admin/admin.controller.js'
// import * as ClientController        from '../controllers/admin/client.controller.js'
// import * as DriverController        from '../controllers/admin/driver.controller.js'
// import * as AssistantDriverController from '../controllers/admin/assistant_driver.controller.js'
// import * as VendorController        from '../controllers/admin/vendor.controller.js'
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

// router.get('/assistant_drivers',        authenticate, isAdmin, AssistantDriverController.getAllAssistantDrivers)
// router.get('/assistant_drivers/:id',    authenticate, isAdmin, AssistantDriverController.getAssistantDriverById)
// router.post('/assistant_drivers',       authenticate, isAdmin, validate(createAssistantDriverSchema), AssistantDriverController.createAssistantDriver)
// router.patch('/assistant_drivers/:id',  authenticate, isAdmin, validate(updateAssistantDriverSchema), AssistantDriverController.updateAssistantDriver)
// router.delete('/assistant_drivers/:id', authenticate, isAdmin, AssistantDriverController.deleteAssistantDriver)

// router.get('/vendors',        authenticate, isAdmin, VendorController.getAllVendors)
// router.get('/vendors/:id',    authenticate, isAdmin, VendorController.getVendorById)
// router.post('/vendors',       authenticate, isAdmin, validate(createVendorSchema), VendorController.createVendor)
// router.patch('/vendors/:id',  authenticate, isAdmin, validate(updateVendorSchema), VendorController.updateVendor)
// router.delete('/vendors/:id', authenticate, isAdmin, VendorController.deleteVendor)

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