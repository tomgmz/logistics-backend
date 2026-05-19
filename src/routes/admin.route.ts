import { Router } from 'express'
import { validate }                  from '../middlewares/validate.middleware.js'
import { authenticate, authorize }   from '../middlewares/auth.middleware.js'
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
import { assignBookingSchema, updateDeliveryStatusSchema } from '../schema/admin/assignment.schema.js'
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
import * as AssignmentController from '../controllers/admin/assignment.controller.js'
import * as UserController from '../controllers/admin/fetch-users.controller.js'
import * as AuditLogController from '../controllers/admin/audit-logs.controller.js'
import { uploadSingle }    from '../middlewares/upload.middleware.js'
import * as UploadController from '../controllers/admin/uploadImage.controller.js'
import * as DriverOCRController from '../controllers/admin/driver-ocr.controller.js'
import {
  createHandlingCodeSchema, updateHandlingCodeSchema,
  createCommoditySchema,    updateCommoditySchema,
  createProductSchema,      updateProductSchema,
} from '../schema/admin/cargo-catalog.schema.js'
import * as CargoCatalogController from '../controllers/admin/cargo-catalog.controller.js'

const router = Router()

// Role groups
const isSuperAdmin = authorize('super_admin', 'it_admin')
const isHR         = authorize('super_admin', 'it_admin', 'human_resources', 'general_manager')
const isFleet      = authorize('super_admin', 'it_admin', 'fleet_admin', 'general_manager', 'client')
const isOperations = authorize('super_admin', 'it_admin', 'operations_admin', 'general_manager', 'client')
const isFinance    = authorize('super_admin', 'it_admin', 'accountant', 'general_manager')

//Admins — super_admin / it_admin only
router.get('/admins',        authenticate, isSuperAdmin, AdminController.getAllAdmins)
router.get('/admins/:id',    authenticate, isSuperAdmin, AdminController.getAdminById)
router.post('/admins',       authenticate, isSuperAdmin, validate(createAdminSchema), AdminController.createAdmin)
router.patch('/admins/:id',  authenticate, isSuperAdmin, validate(updateAdminSchema), AdminController.updateAdmin)
router.delete('/admins/:id', authenticate, isSuperAdmin, AdminController.deleteAdmin)

//Clients
router.get('/clients',        authenticate, isOperations, ClientController.getAllClients)
router.get('/clients/:id',    authenticate, isOperations, ClientController.getClientById)
router.post('/clients',       authenticate, isSuperAdmin,  validate(createClientSchema), ClientController.createClient)
router.patch('/clients/:id',  authenticate, isSuperAdmin,  validate(updateClientSchema), ClientController.updateClient)
router.patch('/clients/:id/deactivate', authenticate, isSuperAdmin, ClientController.deactivateClient)
router.patch('/clients/:id/activate',   authenticate, isSuperAdmin, ClientController.activateClient)
router.delete('/clients/:id', authenticate, isSuperAdmin,  ClientController.deleteClient)

//Drivers
router.get('/drivers',        authenticate, isFleet, DriverController.getAllDrivers)
router.get('/drivers/:id',    authenticate, isFleet, DriverController.getDriverById)
router.post('/drivers/scan-license', authenticate, isFleet, uploadSingle, DriverOCRController.scanDriverLicense)
router.post('/drivers',       authenticate, isFleet, validate(createDriverSchema), DriverController.createDriver)
router.patch('/drivers/:id',  authenticate, isFleet, validate(updateDriverSchema), DriverController.updateDriver)
router.patch('/drivers/:id/deactivate', authenticate, isFleet, DriverController.deactivateDriver)
router.patch('/drivers/:id/activate',   authenticate, isFleet, DriverController.activateDriver)
router.delete('/drivers/:id', authenticate, isFleet, DriverController.deleteDriver)

//Assignments
router.get('/assignments',                    authenticate, isOperations, AssignmentController.getAllAssignments)
router.get('/assignments/:bookingId',         authenticate, isOperations, AssignmentController.getAssignmentByBooking)
router.get('/assignments/:bookingId/history', authenticate, isOperations, AssignmentController.getAssignmentHistory)
router.post('/assignments/:bookingId',        authenticate, isOperations, validate(assignBookingSchema), AssignmentController.assignBooking)
router.patch('/assignments/:bookingId/status', authenticate, isOperations, validate(updateDeliveryStatusSchema), AssignmentController.updateDeliveryStatus)

//Vendors
router.get('/vendors',        authenticate, isFleet,    VendorController.getAllVendors)
router.get('/vendors/:id',    authenticate, isFleet,    VendorController.getVendorById)
router.post('/vendors',       authenticate, isSuperAdmin, validate(createVendorSchema), VendorController.createVendor)
router.patch('/vendors/:id',  authenticate, isSuperAdmin, validate(updateVendorSchema), VendorController.updateVendor)
router.patch('/vendors/:id/deactivate', authenticate, isSuperAdmin, VendorController.deactivateVendor)
router.patch('/vendors/:id/activate',   authenticate, isSuperAdmin, VendorController.activateVendor)
router.delete('/vendors/:id', authenticate, isSuperAdmin, VendorController.deleteVendor)

// ── Trucks
router.get('/trucks',        authenticate, isFleet, TruckController.getAllTrucks)
router.get('/trucks/:id',    authenticate, isFleet, TruckController.getTruckById)
router.post('/trucks',       authenticate, isFleet, validate(createTruckSchema), TruckController.createTruck)
router.patch('/trucks/:id',  authenticate, isFleet, validate(updateTruckSchema), TruckController.updateTruck)
router.delete('/trucks/:id', authenticate, isFleet, TruckController.deleteTruck)

//Truck Models
router.get('/truck-models',        authenticate, isFleet, TruckModelController.getAllTruckModels)
router.get('/truck-models/:id',    authenticate, isFleet, TruckModelController.getTruckModelById)
router.post('/truck-models',       authenticate, isFleet, validate(createTruckModelSchema), TruckModelController.createTruckModel)
router.patch('/truck-models/:id',  authenticate, isFleet, validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
router.delete('/truck-models/:id', authenticate, isFleet, TruckModelController.deleteTruckModel)

//Accountants
router.get('/accountants',        authenticate, isFinance,    AccountantController.getAllAccountants)
router.get('/accountants/:id',    authenticate, isFinance,    AccountantController.getAccountantById)
router.post('/accountants',       authenticate, isSuperAdmin, validate(createAccountantSchema), AccountantController.createAccountant)
router.patch('/accountants/:id',  authenticate, isSuperAdmin, validate(updateAccountantSchema), AccountantController.updateAccountant)
router.delete('/accountants/:id', authenticate, isSuperAdmin, AccountantController.deleteAccountant)
router.patch('/accountants/:id/deactivate', authenticate, isSuperAdmin, AccountantController.deactivateAccountant)
router.patch('/accountants/:id/activate',   authenticate, isSuperAdmin, AccountantController.activateAccountant)

//General Managers
router.get('/general-managers',        authenticate, isSuperAdmin, GeneralManagerController.getAllGeneralManagers)
router.get('/general-managers/:id',    authenticate, isSuperAdmin, GeneralManagerController.getGeneralManagerById)
router.post('/general-managers',       authenticate, isSuperAdmin, validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
router.patch('/general-managers/:id',  authenticate, isSuperAdmin, validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
router.patch('/general-managers/:id/deactivate', authenticate, isSuperAdmin, GeneralManagerController.deactivateGeneralManager)
router.patch('/general-managers/:id/activate',   authenticate, isSuperAdmin, GeneralManagerController.activateGeneralManager)
router.delete('/general-managers/:id', authenticate, isSuperAdmin, GeneralManagerController.deleteGeneralManager)

//Human Resources — isSuperAdmin manages, isHR can view
router.get('/human-resources',        authenticate, isHR,        HumanResourcesController.getAllHumanResources)
router.get('/human-resources/:id',    authenticate, isHR,        HumanResourcesController.getHumanResourcesById)
router.post('/human-resources',       authenticate, isSuperAdmin, validate(createHumanResourcesSchema), HumanResourcesController.createHumanResources)
router.patch('/human-resources/:id',  authenticate, isSuperAdmin, validate(updateHumanResourcesSchema), HumanResourcesController.updateHumanResources)
router.patch('/human-resources/:id/deactivate', authenticate, isSuperAdmin, HumanResourcesController.deactivateHumanResources)
router.patch('/human-resources/:id/activate',   authenticate, isSuperAdmin, HumanResourcesController.activateHumanResources)
router.delete('/human-resources/:id', authenticate, isSuperAdmin, HumanResourcesController.deleteHumanResources)

//Fleet Admins — isSuperAdmin manages, isFleet can view
router.get('/fleet-admins',        authenticate, isFleet,      FleetAdminController.getAllFleetAdmins)
router.get('/fleet-admins/:id',    authenticate, isFleet,      FleetAdminController.getFleetAdminById)
router.post('/fleet-admins',       authenticate, isSuperAdmin, validate(createFleetAdminSchema), FleetAdminController.createFleetAdmin)
router.patch('/fleet-admins/:id',  authenticate, isSuperAdmin, validate(updateFleetAdminSchema), FleetAdminController.updateFleetAdmin)
router.patch('/fleet-admins/:id/deactivate', authenticate, isSuperAdmin, FleetAdminController.deactivateFleetAdmin)
router.patch('/fleet-admins/:id/activate',   authenticate, isSuperAdmin, FleetAdminController.activateFleetAdmin)
router.delete('/fleet-admins/:id', authenticate, isSuperAdmin, FleetAdminController.deleteFleetAdmin)

//Operations Admins — isSuperAdmin manages, isOperations can view
router.get('/operations-admins',        authenticate, isOperations, OperationsAdminController.getAllOperationsAdmins)
router.get('/operations-admins/:id',    authenticate, isOperations, OperationsAdminController.getOperationsAdminById)
router.post('/operations-admins',       authenticate, isSuperAdmin,  validate(createOperationsAdminSchema), OperationsAdminController.createOperationsAdmin)
router.patch('/operations-admins/:id',  authenticate, isSuperAdmin,  validate(updateOperationsAdminSchema), OperationsAdminController.updateOperationsAdmin)
router.patch('/operations-admins/:id/deactivate', authenticate, isSuperAdmin, OperationsAdminController.deactivateOperationsAdmin)
router.patch('/operations-admins/:id/activate',   authenticate, isSuperAdmin, OperationsAdminController.activateOperationsAdmin)
router.delete('/operations-admins/:id', authenticate, isSuperAdmin,  OperationsAdminController.deleteOperationsAdmin)

//IT Admins
router.get('/it-admins',        authenticate, isSuperAdmin, ITAdminController.getAllITAdmins)
router.get('/it-admins/:id',    authenticate, isSuperAdmin, ITAdminController.getITAdminById)
router.post('/it-admins',       authenticate, isSuperAdmin, validate(createITAdminSchema), ITAdminController.createITAdmin)
router.patch('/it-admins/:id',  authenticate, isSuperAdmin, validate(updateITAdminSchema), ITAdminController.updateITAdmin)
router.patch('/it-admins/:id/deactivate', authenticate, isSuperAdmin, ITAdminController.deactivateITAdmin)
router.patch('/it-admins/:id/activate',   authenticate, isSuperAdmin, ITAdminController.activateITAdmin)
router.delete('/it-admins/:id', authenticate, isSuperAdmin, ITAdminController.deleteITAdmin)

//Fetch all users
router.get('/users',       authenticate, isSuperAdmin, UserController.getUsers)
router.get('/users/stats', authenticate, isSuperAdmin, UserController.getUserStats)

// Audit logs
router.get('/audit-logs',        authenticate, isSuperAdmin, AuditLogController.getAllLogs)
router.get('/audit-logs/stats',  authenticate, isSuperAdmin, AuditLogController.getLogStats)
router.get('/audit-logs/:id',    authenticate, isSuperAdmin, AuditLogController.getLogById)

//upload
router.post('/upload/image', authenticate, isFleet, uploadSingle, UploadController.uploadImage)

// Handling Codes
router.get('/handling-codes',        authenticate, isOperations, CargoCatalogController.getAllHandlingCodes)
router.get('/handling-codes/:id',    authenticate, isOperations, CargoCatalogController.getHandlingCodeById)
router.post('/handling-codes',       authenticate, isOperations, validate(createHandlingCodeSchema), CargoCatalogController.createHandlingCode)
router.patch('/handling-codes/:id',  authenticate, isOperations, validate(updateHandlingCodeSchema), CargoCatalogController.updateHandlingCode)
router.delete('/handling-codes/:id', authenticate, isOperations, CargoCatalogController.deleteHandlingCode)

// Commodities
router.get('/commodities',        authenticate, isOperations, CargoCatalogController.getAllCommodities)
router.get('/commodities/:id',    authenticate, isOperations, CargoCatalogController.getCommodityById)
router.post('/commodities',       authenticate, isOperations, validate(createCommoditySchema), CargoCatalogController.createCommodity)
router.patch('/commodities/:id',  authenticate, isOperations, validate(updateCommoditySchema), CargoCatalogController.updateCommodity)
router.delete('/commodities/:id', authenticate, isOperations, CargoCatalogController.deleteCommodity)

// Products — supports ?commodity_id= filter on GET /products
router.get('/products',        authenticate, isOperations, CargoCatalogController.getAllProducts)
router.get('/products/:id',    authenticate, isOperations, CargoCatalogController.getProductById)
router.post('/products',       authenticate, isOperations, validate(createProductSchema), CargoCatalogController.createProduct)
router.patch('/products/:id',  authenticate, isOperations, validate(updateProductSchema), CargoCatalogController.updateProduct)
router.delete('/products/:id', authenticate, isOperations, CargoCatalogController.deleteProduct)

export default router