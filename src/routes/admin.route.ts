// import { Router } from 'express'
// import { validate } from '../middlewares/validate.middleware.js'
// import { createAdminSchema, updateAdminSchema }               from '../schema/admin/admin.schema.js'
// import { createClientSchema, updateClientSchema }             from '../schema/admin/client.schema.js'
// import { createDriverSchema, updateDriverSchema }             from '../schema/admin/driver.schema.js'
// import { createTruckSchema, updateTruckSchema }               from '../schema/admin/truck.schema.js'
// import { createTruckModelSchema, updateTruckModelSchema }     from '../schema/admin/truck-model.schema.js'
// import { createVendorSchema, updateVendorSchema }             from '../schema/admin/vendor.schema.js'
// import { createAccountantSchema, updateAccountantSchema }     from '../schema/admin/accountant.schema.js'
// import { createGeneralManagerSchema, updateGeneralManagerSchema } from '../schema/admin/general_manager.schema.js'
// import * as AdminController         from '../controllers/admin/admin.controller.js'
// import * as ClientController        from '../controllers/admin/client.controller.js'
// import * as DriverController        from '../controllers/admin/driver.controller.js'
// import * as VendorController        from '../controllers/admin/vendor.controller.js'
// import * as TruckController         from '../controllers/admin/truck.controller.js'
// import * as TruckModelController    from '../controllers/admin/truck-model.controller.js'
// import * as AccountantController    from '../controllers/admin/accountant.controller.js'
// import * as GeneralManagerController from '../controllers/admin/general_manager.controller.js'

// const router = Router()

// // Admins
// router.get('/admins',        AdminController.getAllAdmins)
// router.get('/admins/:id',    AdminController.getAdminById)
// router.post('/admins',       validate(createAdminSchema), AdminController.createAdmin)
// router.patch('/admins/:id',  validate(updateAdminSchema), AdminController.updateAdmin)
// router.delete('/admins/:id', AdminController.deleteAdmin)

// // Clients
// router.get('/clients',        ClientController.getAllClients)
// router.get('/clients/:id',    ClientController.getClientById)
// router.post('/clients',       validate(createClientSchema), ClientController.createClient)
// router.patch('/clients/:id',  validate(updateClientSchema), ClientController.updateClient)
// router.delete('/clients/:id', ClientController.deleteClient)

// // Drivers
// router.get('/drivers',        DriverController.getAllDrivers)
// router.get('/drivers/:id',    DriverController.getDriverById)
// router.post('/drivers',       validate(createDriverSchema), DriverController.createDriver)
// router.patch('/drivers/:id',  validate(updateDriverSchema), DriverController.updateDriver)
// router.delete('/drivers/:id', DriverController.deleteDriver)

// // Vendors
// router.get('/vendors',        VendorController.getAllVendors)
// router.get('/vendors/:id',    VendorController.getVendorById)
// router.post('/vendors',       validate(createVendorSchema), VendorController.createVendor)
// router.patch('/vendors/:id',  validate(updateVendorSchema), VendorController.updateVendor)
// router.delete('/vendors/:id', VendorController.deleteVendor)

// // Trucks
// router.get('/trucks',        TruckController.getAllTrucks)
// router.get('/trucks/:id',    TruckController.getTruckById)
// router.post('/trucks',       validate(createTruckSchema), TruckController.createTruck)
// router.patch('/trucks/:id',  validate(updateTruckSchema), TruckController.updateTruck)
// router.delete('/trucks/:id', TruckController.deleteTruck)

// // Truck Models
// router.get('/truck-models',        TruckModelController.getAllTruckModels)
// router.get('/truck-models/:id',    TruckModelController.getTruckModelById)
// router.post('/truck-models',       validate(createTruckModelSchema), TruckModelController.createTruckModel)
// router.patch('/truck-models/:id',  validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
// router.delete('/truck-models/:id', TruckModelController.deleteTruckModel)

// // Accountants
// router.get('/accountants',        AccountantController.getAllAccountants)
// router.get('/accountants/:id',    AccountantController.getAccountantById)
// router.post('/accountants',       validate(createAccountantSchema), AccountantController.createAccountant)
// router.patch('/accountants/:id',  validate(updateAccountantSchema), AccountantController.updateAccountant)
// router.delete('/accountants/:id', AccountantController.deleteAccountant)

// // General Managers
// router.get('/general-managers',        GeneralManagerController.getAllGeneralManagers)
// router.get('/general-managers/:id',    GeneralManagerController.getGeneralManagerById)
// router.post('/general-managers',       validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
// router.patch('/general-managers/:id',  validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
// router.delete('/general-managers/:id', GeneralManagerController.deleteGeneralManager)

// export default router



// import { Router } from 'express'
// import { validate }                  from '../middlewares/validate.middleware.js'
// import { authenticate, authorize }   from '../middlewares/auth.middleware.js'
// import { authenticatedLimiter }      from '../middlewares/rateLimit.middleware.js'
// import { createAdminSchema, updateAdminSchema }               from '../schema/admin/admin.schema.js'
// import { createClientSchema, updateClientSchema }             from '../schema/admin/client.schema.js'
// import { createDriverSchema, updateDriverSchema }             from '../schema/admin/driver.schema.js'
// import { createTruckSchema, updateTruckSchema }               from '../schema/admin/truck.schema.js'
// import { createTruckModelSchema, updateTruckModelSchema }     from '../schema/admin/truck-model.schema.js'
// import { createVendorSchema, updateVendorSchema }             from '../schema/admin/vendor.schema.js'
// import { createAccountantSchema, updateAccountantSchema }     from '../schema/admin/accountant.schema.js'
// import { createGeneralManagerSchema, updateGeneralManagerSchema } from '../schema/admin/general_manager.schema.js'
// import * as AdminController           from '../controllers/admin/admin.controller.js'
// import * as ClientController          from '../controllers/admin/client.controller.js'
// import * as DriverController          from '../controllers/admin/driver.controller.js'
// import * as VendorController          from '../controllers/admin/vendor.controller.js'
// import * as TruckController           from '../controllers/admin/truck.controller.js'
// import * as TruckModelController      from '../controllers/admin/truck-model.controller.js'
// import * as AccountantController      from '../controllers/admin/accountant.controller.js'
// import * as GeneralManagerController  from '../controllers/admin/general_manager.controller.js'

// const router = Router()

// // Role groups
// const isSuperAdmin      = authorize('super_admin', 'it_admin')
// const isAnyAdmin        = authorize('super_admin', 'it_admin', 'general_manager', 'fleet_admin', 'operations_admin', 'human_resources', 'accountant')
// const isHR              = authorize('super_admin', 'it_admin', 'human_resources', 'general_manager')
// const isFleet           = authorize('super_admin', 'it_admin', 'fleet_admin', 'general_manager')
// const isOperations      = authorize('super_admin', 'it_admin', 'operations_admin', 'general_manager')
// const isFinance         = authorize('super_admin', 'it_admin', 'accountant', 'general_manager')

// // Admins — super_admin / it_admin only
// router.get('/admins',        authenticate, authenticatedLimiter, isSuperAdmin, AdminController.getAllAdmins)
// router.get('/admins/:id',    authenticate, authenticatedLimiter, isSuperAdmin, AdminController.getAdminById)
// router.post('/admins',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createAdminSchema), AdminController.createAdmin)
// router.patch('/admins/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateAdminSchema), AdminController.updateAdmin)
// router.delete('/admins/:id', authenticate, authenticatedLimiter, isSuperAdmin, AdminController.deleteAdmin)

// // Clients — operations + finance can view, super_admin manages
// router.get('/clients',        authenticate, authenticatedLimiter, isOperations, ClientController.getAllClients)
// router.get('/clients/:id',    authenticate, authenticatedLimiter, isOperations, ClientController.getClientById)
// router.post('/clients',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createClientSchema), ClientController.createClient)
// router.patch('/clients/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateClientSchema), ClientController.updateClient)
// router.delete('/clients/:id', authenticate, authenticatedLimiter, isSuperAdmin, ClientController.deleteClient)

// // Drivers — fleet manages
// router.get('/drivers',        authenticate, authenticatedLimiter, isFleet, DriverController.getAllDrivers)
// router.get('/drivers/:id',    authenticate, authenticatedLimiter, isFleet, DriverController.getDriverById)
// router.post('/drivers',       authenticate, authenticatedLimiter, isFleet, validate(createDriverSchema), DriverController.createDriver)
// router.patch('/drivers/:id',  authenticate, authenticatedLimiter, isFleet, validate(updateDriverSchema), DriverController.updateDriver)
// router.delete('/drivers/:id', authenticate, authenticatedLimiter, isFleet, DriverController.deleteDriver)

// // Vendors — operations + fleet can view, super_admin manages
// router.get('/vendors',        authenticate, authenticatedLimiter, isFleet,    VendorController.getAllVendors)
// router.get('/vendors/:id',    authenticate, authenticatedLimiter, isFleet,    VendorController.getVendorById)
// router.post('/vendors',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createVendorSchema), VendorController.createVendor)
// router.patch('/vendors/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateVendorSchema), VendorController.updateVendor)
// router.delete('/vendors/:id', authenticate, authenticatedLimiter, isSuperAdmin, VendorController.deleteVendor)

// // Trucks — fleet manages
// router.get('/trucks',        authenticate, authenticatedLimiter, isFleet, TruckController.getAllTrucks)
// router.get('/trucks/:id',    authenticate, authenticatedLimiter, isFleet, TruckController.getTruckById)
// router.post('/trucks',       authenticate, authenticatedLimiter, isFleet, validate(createTruckSchema), TruckController.createTruck)
// router.patch('/trucks/:id',  authenticate, authenticatedLimiter, isFleet, validate(updateTruckSchema), TruckController.updateTruck)
// router.delete('/trucks/:id', authenticate, authenticatedLimiter, isFleet, TruckController.deleteTruck)

// // Truck Models — fleet manages
// router.get('/truck-models',        authenticate, authenticatedLimiter, isFleet, TruckModelController.getAllTruckModels)
// router.get('/truck-models/:id',    authenticate, authenticatedLimiter, isFleet, TruckModelController.getTruckModelById)
// router.post('/truck-models',       authenticate, authenticatedLimiter, isFleet, validate(createTruckModelSchema), TruckModelController.createTruckModel)
// router.patch('/truck-models/:id',  authenticate, authenticatedLimiter, isFleet, validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
// router.delete('/truck-models/:id', authenticate, authenticatedLimiter, isFleet, TruckModelController.deleteTruckModel)

// // Accountants — HR + finance manage, super_admin owns
// router.get('/accountants',        authenticate, authenticatedLimiter, isFinance,   AccountantController.getAllAccountants)
// router.get('/accountants/:id',    authenticate, authenticatedLimiter, isFinance,   AccountantController.getAccountantById)
// router.post('/accountants',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createAccountantSchema), AccountantController.createAccountant)
// router.patch('/accountants/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateAccountantSchema), AccountantController.updateAccountant)
// router.delete('/accountants/:id', authenticate, authenticatedLimiter, isSuperAdmin, AccountantController.deleteAccountant)

// // General Managers — super_admin only
// router.get('/general-managers',        authenticate, authenticatedLimiter, isSuperAdmin, GeneralManagerController.getAllGeneralManagers)
// router.get('/general-managers/:id',    authenticate, authenticatedLimiter, isSuperAdmin, GeneralManagerController.getGeneralManagerById)
// router.post('/general-managers',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
// router.patch('/general-managers/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
// router.delete('/general-managers/:id', authenticate, authenticatedLimiter, isSuperAdmin, GeneralManagerController.deleteGeneralManager)

// export default router


import { Router } from 'express'
import { validate }                  from '../middlewares/validate.middleware.js'
import { authenticate, authorize }   from '../middlewares/auth.middleware.js'
import { authenticatedLimiter }      from '../middlewares/rateLimit.middleware.js'
import { createAdminSchema, updateAdminSchema }                       from '../schema/admin/admin.schema.js'
import { createClientSchema, updateClientSchema }                     from '../schema/admin/client.schema.js'
import { createDriverSchema, updateDriverSchema }                     from '../schema/admin/driver.schema.js'
import { createTruckSchema, updateTruckSchema }                       from '../schema/admin/truck.schema.js'
import { createTruckModelSchema, updateTruckModelSchema }             from '../schema/admin/truck-model.schema.js'
import { createVendorSchema, updateVendorSchema }                     from '../schema/admin/vendor.schema.js'
import { createAccountantSchema, updateAccountantSchema }             from '../schema/admin/accountant.schema.js'
import { createGeneralManagerSchema, updateGeneralManagerSchema }     from '../schema/admin/general_manager.schema.js'
import { createHumanResourcesSchema, updateHumanResourcesSchema }    from '../schema/admin/admin_roles.schema.js'
import { createFleetAdminSchema, updateFleetAdminSchema }             from '../schema/admin/admin_roles.schema.js'
import { createOperationsAdminSchema, updateOperationsAdminSchema }   from '../schema/admin/admin_roles.schema.js'
import { createITAdminSchema, updateITAdminSchema }   from '../schema/admin/it_admin.schema.js'
import * as AdminController           from '../controllers/admin/admin.controller.js'
import * as ClientController          from '../controllers/admin/client.controller.js'
import * as DriverController          from '../controllers/admin/driver.controller.js'
import * as VendorController          from '../controllers/admin/vendor.controller.js'
import * as TruckController           from '../controllers/admin/truck.controller.js'
import * as TruckModelController      from '../controllers/admin/truck-model.controller.js'
import * as AccountantController      from '../controllers/admin/accountant.controller.js'
import * as GeneralManagerController  from '../controllers/admin/general_manager.controller.js'
import * as HumanResourcesController  from '../controllers/admin/human_resources.controller.js'
import * as FleetAdminController      from '../controllers/admin/fleet_admin.controller.js'
import * as OperationsAdminController from '../controllers/admin/operations_admin.controller.js'
import * as ITAdminController from '../controllers/admin/it_admin.controller.js'
import * as UserController from '../controllers/admin/fetch-users.controller.js'

const router = Router()

// Role groups
const isSuperAdmin = authorize('super_admin', 'it_admin')
const isHR         = authorize('super_admin', 'it_admin', 'human_resources', 'general_manager')
const isFleet      = authorize('super_admin', 'it_admin', 'fleet_admin', 'general_manager', 'client')
const isOperations = authorize('super_admin', 'it_admin', 'operations_admin', 'general_manager')
const isFinance    = authorize('super_admin', 'it_admin', 'accountant', 'general_manager')

//Admins — super_admin / it_admin only
router.get('/admins',        authenticate, authenticatedLimiter, isSuperAdmin, AdminController.getAllAdmins)
router.get('/admins/:id',    authenticate, authenticatedLimiter, isSuperAdmin, AdminController.getAdminById)
router.post('/admins',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createAdminSchema), AdminController.createAdmin)
router.patch('/admins/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateAdminSchema), AdminController.updateAdmin)
router.delete('/admins/:id', authenticate, authenticatedLimiter, isSuperAdmin, AdminController.deleteAdmin)

//Clients
router.get('/clients',        authenticate, authenticatedLimiter, isOperations, ClientController.getAllClients)
router.get('/clients/:id',    authenticate, authenticatedLimiter, isOperations, ClientController.getClientById)
router.post('/clients',       authenticate, authenticatedLimiter, isSuperAdmin,  validate(createClientSchema), ClientController.createClient)
router.patch('/clients/:id',  authenticate, authenticatedLimiter, isSuperAdmin,  validate(updateClientSchema), ClientController.updateClient)
router.delete('/clients/:id', authenticate, authenticatedLimiter, isSuperAdmin,  ClientController.deleteClient)

//Drivers
router.get('/drivers',        authenticate, authenticatedLimiter, isFleet, DriverController.getAllDrivers)
router.get('/drivers/:id',    authenticate, authenticatedLimiter, isFleet, DriverController.getDriverById)
router.post('/drivers',       authenticate, authenticatedLimiter, isFleet, validate(createDriverSchema), DriverController.createDriver)
router.patch('/drivers/:id',  authenticate, authenticatedLimiter, isFleet, validate(updateDriverSchema), DriverController.updateDriver)
router.delete('/drivers/:id', authenticate, authenticatedLimiter, isFleet, DriverController.deleteDriver)

//Vendors
router.get('/vendors',        authenticate, authenticatedLimiter, isFleet,    VendorController.getAllVendors)
router.get('/vendors/:id',    authenticate, authenticatedLimiter, isFleet,    VendorController.getVendorById)
router.post('/vendors',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createVendorSchema), VendorController.createVendor)
router.patch('/vendors/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateVendorSchema), VendorController.updateVendor)
router.delete('/vendors/:id', authenticate, authenticatedLimiter, isSuperAdmin, VendorController.deleteVendor)

// ── Trucks
router.get('/trucks',        authenticate, authenticatedLimiter, isFleet, TruckController.getAllTrucks)
router.get('/trucks/:id',    authenticate, authenticatedLimiter, isFleet, TruckController.getTruckById)
router.post('/trucks',       authenticate, authenticatedLimiter, isFleet, validate(createTruckSchema), TruckController.createTruck)
router.patch('/trucks/:id',  authenticate, authenticatedLimiter, isFleet, validate(updateTruckSchema), TruckController.updateTruck)
router.delete('/trucks/:id', authenticate, authenticatedLimiter, isFleet, TruckController.deleteTruck)

//Truck Models
router.get('/truck-models',        authenticate, authenticatedLimiter, isFleet, TruckModelController.getAllTruckModels)
router.get('/truck-models/:id',    authenticate, authenticatedLimiter, isFleet, TruckModelController.getTruckModelById)
router.post('/truck-models',       authenticate, authenticatedLimiter, isFleet, validate(createTruckModelSchema), TruckModelController.createTruckModel)
router.patch('/truck-models/:id',  authenticate, authenticatedLimiter, isFleet, validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
router.delete('/truck-models/:id', authenticate, authenticatedLimiter, isFleet, TruckModelController.deleteTruckModel)

//Accountants
router.get('/accountants',        authenticate, authenticatedLimiter, isFinance,    AccountantController.getAllAccountants)
router.get('/accountants/:id',    authenticate, authenticatedLimiter, isFinance,    AccountantController.getAccountantById)
router.post('/accountants',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createAccountantSchema), AccountantController.createAccountant)
router.patch('/accountants/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateAccountantSchema), AccountantController.updateAccountant)
router.delete('/accountants/:id', authenticate, authenticatedLimiter, isSuperAdmin, AccountantController.deleteAccountant)

//General Managers
router.get('/general-managers',        authenticate, authenticatedLimiter, isSuperAdmin, GeneralManagerController.getAllGeneralManagers)
router.get('/general-managers/:id',    authenticate, authenticatedLimiter, isSuperAdmin, GeneralManagerController.getGeneralManagerById)
router.post('/general-managers',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
router.patch('/general-managers/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
router.delete('/general-managers/:id', authenticate, authenticatedLimiter, isSuperAdmin, GeneralManagerController.deleteGeneralManager)

//Human Resources — isSuperAdmin manages, isHR can view
router.get('/human-resources',        authenticate, authenticatedLimiter, isHR,        HumanResourcesController.getAllHumanResources)
router.get('/human-resources/:id',    authenticate, authenticatedLimiter, isHR,        HumanResourcesController.getHumanResourcesById)
router.post('/human-resources',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createHumanResourcesSchema), HumanResourcesController.createHumanResources)
router.patch('/human-resources/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateHumanResourcesSchema), HumanResourcesController.updateHumanResources)
router.delete('/human-resources/:id', authenticate, authenticatedLimiter, isSuperAdmin, HumanResourcesController.deleteHumanResources)

//Fleet Admins — isSuperAdmin manages, isFleet can view
router.get('/fleet-admins',        authenticate, authenticatedLimiter, isFleet,      FleetAdminController.getAllFleetAdmins)
router.get('/fleet-admins/:id',    authenticate, authenticatedLimiter, isFleet,      FleetAdminController.getFleetAdminById)
router.post('/fleet-admins',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createFleetAdminSchema), FleetAdminController.createFleetAdmin)
router.patch('/fleet-admins/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateFleetAdminSchema), FleetAdminController.updateFleetAdmin)
router.delete('/fleet-admins/:id', authenticate, authenticatedLimiter, isSuperAdmin, FleetAdminController.deleteFleetAdmin)

//Operations Admins — isSuperAdmin manages, isOperations can view
router.get('/operations-admins',        authenticate, authenticatedLimiter, isOperations, OperationsAdminController.getAllOperationsAdmins)
router.get('/operations-admins/:id',    authenticate, authenticatedLimiter, isOperations, OperationsAdminController.getOperationsAdminById)
router.post('/operations-admins',       authenticate, authenticatedLimiter, isSuperAdmin,  validate(createOperationsAdminSchema), OperationsAdminController.createOperationsAdmin)
router.patch('/operations-admins/:id',  authenticate, authenticatedLimiter, isSuperAdmin,  validate(updateOperationsAdminSchema), OperationsAdminController.updateOperationsAdmin)
router.delete('/operations-admins/:id', authenticate, authenticatedLimiter, isSuperAdmin,  OperationsAdminController.deleteOperationsAdmin)

//IT Admins
router.get('/it-admins',        authenticate, authenticatedLimiter, isSuperAdmin, ITAdminController.getAllITAdmins)
router.get('/it-admins/:id',    authenticate, authenticatedLimiter, isSuperAdmin, ITAdminController.getITAdminById)
router.post('/it-admins',       authenticate, authenticatedLimiter, isSuperAdmin, validate(createITAdminSchema), ITAdminController.createITAdmin)
router.patch('/it-admins/:id',  authenticate, authenticatedLimiter, isSuperAdmin, validate(updateITAdminSchema), ITAdminController.updateITAdmin)
router.delete('/it-admins/:id', authenticate, authenticatedLimiter, isSuperAdmin, ITAdminController.deleteITAdmin)

//Fetch all users
router.get('/users',       authenticate, authenticatedLimiter, isSuperAdmin, UserController.getUsers)
router.get('/users/stats', authenticate, authenticatedLimiter, isSuperAdmin, UserController.getUserStats)

export default router