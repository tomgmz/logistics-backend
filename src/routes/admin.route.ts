import { Router } from 'express'
import { validate }                  from '../middlewares/validate.middleware.js'
import { authenticate, authorize }   from '../middlewares/auth.middleware.js'
import { createAdminSchema, updateAdminSchema }                       from '../schema/admin/admin.schema.js'
import { createClientSchema, updateClientSchema }                     from '../schema/admin/client.schema.js'
import { createDriverSchema, updateDriverSchema }                     from '../schema/admin/driver.schema.js'
import { createTruckSchema, updateTruckSchema, recordTruckInspectionSchema } from '../schema/admin/truck.schema.js'
import { createTruckModelSchema, updateTruckModelSchema }             from '../schema/admin/truck-model.schema.js'
import { createAccountantSchema, updateAccountantSchema, setGmProxySchema } from '../schema/admin/accountant.schema.js'
import { createGeneralManagerSchema, updateGeneralManagerSchema }     from '../schema/admin/general_manager.schema.js'
import { createFleetAdminSchema, updateFleetAdminSchema }             from '../schema/admin/admin_roles.schema.js'
import { createOperationsAdminSchema, updateOperationsAdminSchema }   from '../schema/admin/admin_roles.schema.js'
import { createITAdminSchema, updateITAdminSchema }   from '../schema/admin/it-admin.schema.js'
import { assignBookingSchema, updateDeliveryStatusSchema } from '../schema/admin/assignment.schema.js'
import * as AdminController           from '../controllers/admin/admin.controller.js'
import * as ClientController          from '../controllers/admin/client.controller.js'
import * as DriverController          from '../controllers/admin/driver.controller.js'
import * as TruckController           from '../controllers/admin/truck.controller.js'
import * as TruckModelController      from '../controllers/admin/truck-model.controller.js'
import * as AccountantController      from '../controllers/admin/accountant.controller.js'
import * as GeneralManagerController  from '../controllers/admin/general_manager.controller.js'
import * as FleetAdminController      from '../controllers/admin/fleet_admin.controller.js'
import * as OperationsAdminController from '../controllers/admin/operations_admin.controller.js'
import * as ITAdminController from '../controllers/admin/it-admin.controller.js'
import * as AssignmentController from '../controllers/admin/assignment.controller.js'
import * as UserController from '../controllers/admin/fetch-users.controller.js'
import * as AuditLogController from '../controllers/admin/audit-logs.controller.js'
import * as PermissionsController from '../controllers/admin/permissions.controller.js'
import { replacePermissionsSchema } from '../schema/admin/permissions.schema.js'
import { uploadSingle }    from '../middlewares/upload.middleware.js'
import * as UploadController from '../controllers/admin/uploadImage.controller.js'
import * as DriverOCRController from '../controllers/admin/driver-ocr.controller.js'
import {
  createHandlingCodeSchema, updateHandlingCodeSchema,
  createCommoditySchema,    updateCommoditySchema,
  createProductSchema,      updateProductSchema,
} from '../schema/admin/cargo-catalog.schema.js'
import * as CargoCatalogController from '../controllers/admin/cargo-catalog.controller.js'
import { createLandlinePrefixSchema, updateLandlinePrefixSchema } from '../schema/admin/landline-prefix.schema.js'
import * as LandlinePrefixController from '../controllers/admin/landline-prefix.controller.js'

const router = Router()

// Role groups
const isAdmin = authorize('admin', 'it_admin')
const isFleet      = authorize('admin', 'it_admin', 'fleet_manager', 'general_manager', 'client')
const isOperations = authorize('admin', 'it_admin', 'operations_manager', 'general_manager', 'client')
// Read-only view of drivers/trucks for operations (needed to populate the
// assignment dropdowns). CRUD stays restricted to isFleet.
const isFleetRead  = authorize('admin', 'it_admin', 'fleet_manager', 'general_manager', 'client', 'operations_manager')
const isFinance    = authorize('admin', 'it_admin', 'accountant', 'general_manager')

//Admins — admin / it_admin only
router.get('/admins',        authenticate, isAdmin, AdminController.getAllAdmins)
router.get('/admins/:id',    authenticate, isAdmin, AdminController.getAdminById)
router.post('/admins',       authenticate, isAdmin, validate(createAdminSchema), AdminController.createAdmin)
router.patch('/admins/:id',  authenticate, isAdmin, validate(updateAdminSchema), AdminController.updateAdmin)
router.patch('/admins/:id/deactivate', authenticate, isAdmin, AdminController.deactivateAdmin)
router.patch('/admins/:id/activate',   authenticate, isAdmin, AdminController.activateAdmin)
router.delete('/admins/:id', authenticate, isAdmin, AdminController.deleteAdmin)

//Clients
router.get('/clients',        authenticate, isOperations, ClientController.getAllClients)
router.get('/clients/:id',    authenticate, isOperations, ClientController.getClientById)
router.post('/clients',       authenticate, isAdmin,  validate(createClientSchema), ClientController.createClient)
router.patch('/clients/:id',  authenticate, isAdmin,  validate(updateClientSchema), ClientController.updateClient)
router.patch('/clients/:id/deactivate', authenticate, isAdmin, ClientController.deactivateClient)
router.patch('/clients/:id/activate',   authenticate, isAdmin, ClientController.activateClient)
router.delete('/clients/:id', authenticate, isAdmin,  ClientController.deleteClient)

// Drivers
router.get('/drivers',                     authenticate, isFleetRead, DriverController.getAllDrivers)
router.post('/drivers/scan-license',       authenticate, isFleet, uploadSingle, DriverOCRController.scanDriverLicense)
router.get('/drivers/:id',                 authenticate, isFleetRead, DriverController.getDriverById)
router.post('/drivers',                    authenticate, isFleet, uploadSingle, validate(createDriverSchema), DriverController.createDriver)
router.patch('/drivers/:id',               authenticate, isFleet, validate(updateDriverSchema), DriverController.updateDriver)
router.patch('/drivers/:id/deactivate',    authenticate, isFleet, DriverController.deactivateDriver)
router.patch('/drivers/:id/activate',      authenticate, isFleet, DriverController.activateDriver)
router.delete('/drivers/:id',              authenticate, isFleet, DriverController.deleteDriver)

//Assignments
router.get('/assignments',                    authenticate, isOperations, AssignmentController.getAllAssignments)
router.get('/assignments/:bookingId',         authenticate, isOperations, AssignmentController.getAssignmentByBooking)
router.get('/assignments/:bookingId/history', authenticate, isOperations, AssignmentController.getAssignmentHistory)
router.post('/assignments/:bookingId',        authenticate, isOperations, validate(assignBookingSchema), AssignmentController.assignBooking)
router.patch('/assignments/:bookingId/status', authenticate, isOperations, validate(updateDeliveryStatusSchema), AssignmentController.updateDeliveryStatus)

// Trucks
router.get('/trucks',        authenticate, isFleetRead, TruckController.getAllTrucks)
router.get('/trucks/:id',    authenticate, isFleetRead, TruckController.getTruckById)
// BLOWBAGETS inspections live on the VEHICLE: the fleet manager records them
// here, and only a vehicle whose latest inspection passed can be picked by
// operations. Read is open to the same roles that can read the fleet so the
// assignment UI can show readiness.
router.get('/trucks/:id/inspections',  authenticate, isFleetRead, TruckController.getTruckInspections)
router.post('/trucks/:id/inspections', authenticate, isFleet, validate(recordTruckInspectionSchema), TruckController.recordTruckInspection)
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
router.post('/accountants',       authenticate, isAdmin, validate(createAccountantSchema), AccountantController.createAccountant)
router.patch('/accountants/:id',  authenticate, isAdmin, validate(updateAccountantSchema), AccountantController.updateAccountant)
router.delete('/accountants/:id', authenticate, isAdmin, AccountantController.deleteAccountant)
router.patch('/accountants/:id/deactivate', authenticate, isAdmin, AccountantController.deactivateAccountant)
router.patch('/accountants/:id/activate',   authenticate, isAdmin, AccountantController.activateAccountant)
// Appoint an accountant to stand in for the general manager on booking approvals.
router.patch('/accountants/:id/gm-proxy',   authenticate, isAdmin, validate(setGmProxySchema), AccountantController.setAccountantGmProxy)

//General Managers
router.get('/general-managers',        authenticate, isAdmin, GeneralManagerController.getAllGeneralManagers)
router.get('/general-managers/:id',    authenticate, isAdmin, GeneralManagerController.getGeneralManagerById)
router.post('/general-managers',       authenticate, isAdmin, validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
router.patch('/general-managers/:id',  authenticate, isAdmin, validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
router.patch('/general-managers/:id/deactivate', authenticate, isAdmin, GeneralManagerController.deactivateGeneralManager)
router.patch('/general-managers/:id/activate',   authenticate, isAdmin, GeneralManagerController.activateGeneralManager)
router.delete('/general-managers/:id', authenticate, isAdmin, GeneralManagerController.deleteGeneralManager)

//Fleet Admins — isAdmin manages, isFleet can view
router.get('/fleet-admins',        authenticate, isFleet,      FleetAdminController.getAllFleetAdmins)
router.get('/fleet-admins/:id',    authenticate, isFleet,      FleetAdminController.getFleetAdminById)
router.post('/fleet-admins',       authenticate, isAdmin, validate(createFleetAdminSchema), FleetAdminController.createFleetAdmin)
router.patch('/fleet-admins/:id',  authenticate, isAdmin, validate(updateFleetAdminSchema), FleetAdminController.updateFleetAdmin)
router.patch('/fleet-admins/:id/deactivate', authenticate, isAdmin, FleetAdminController.deactivateFleetAdmin)
router.patch('/fleet-admins/:id/activate',   authenticate, isAdmin, FleetAdminController.activateFleetAdmin)
router.delete('/fleet-admins/:id', authenticate, isAdmin, FleetAdminController.deleteFleetAdmin)

//Operations Admins — isAdmin manages, isOperations can view
router.get('/operations-admins',        authenticate, isOperations, OperationsAdminController.getAllOperationsAdmins)
router.get('/operations-admins/:id',    authenticate, isOperations, OperationsAdminController.getOperationsAdminById)
router.post('/operations-admins',       authenticate, isAdmin,  validate(createOperationsAdminSchema), OperationsAdminController.createOperationsAdmin)
router.patch('/operations-admins/:id',  authenticate, isAdmin,  validate(updateOperationsAdminSchema), OperationsAdminController.updateOperationsAdmin)
router.patch('/operations-admins/:id/deactivate', authenticate, isAdmin, OperationsAdminController.deactivateOperationsAdmin)
router.patch('/operations-admins/:id/activate',   authenticate, isAdmin, OperationsAdminController.activateOperationsAdmin)
router.delete('/operations-admins/:id', authenticate, isAdmin,  OperationsAdminController.deleteOperationsAdmin)

//IT Admins
router.get('/it-admins',        authenticate, isAdmin, ITAdminController.getAllITAdmins)
router.get('/it-admins/:id',    authenticate, isAdmin, ITAdminController.getITAdminById)
router.post('/it-admins',       authenticate, isAdmin, validate(createITAdminSchema), ITAdminController.createITAdmin)
router.patch('/it-admins/:id',  authenticate, isAdmin, validate(updateITAdminSchema), ITAdminController.updateITAdmin)
router.patch('/it-admins/:id/deactivate', authenticate, isAdmin, ITAdminController.deactivateITAdmin)
router.patch('/it-admins/:id/activate',   authenticate, isAdmin, ITAdminController.activateITAdmin)
router.delete('/it-admins/:id', authenticate, isAdmin, ITAdminController.deleteITAdmin)

//Fetch all users
router.get('/users',       authenticate, isAdmin, UserController.getUsers)
router.get('/users/stats', authenticate, isAdmin, UserController.getUserStats)

//Module permissions (RBAC) — managed by admin / it_admin
router.get('/users/:id/permissions', authenticate, isAdmin, PermissionsController.getUserPermissions)
router.put('/users/:id/permissions', authenticate, isAdmin, validate(replacePermissionsSchema), PermissionsController.setUserPermissions)

// Audit logs
router.get('/audit-logs',        authenticate, isAdmin, AuditLogController.getAllLogs)
router.get('/audit-logs/stats',  authenticate, isAdmin, AuditLogController.getLogStats)
router.get('/audit-logs/:id',    authenticate, isAdmin, AuditLogController.getLogById)

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

//landline prefixes
router.get('/landline-prefixes',        authenticate, isOperations, LandlinePrefixController.getAllLandlinePrefixes)
router.get('/landline-prefixes/:id',    authenticate, isOperations, LandlinePrefixController.getLandlinePrefixById)
router.post('/landline-prefixes',       authenticate, isAdmin, validate(createLandlinePrefixSchema), LandlinePrefixController.createLandlinePrefix)
router.patch('/landline-prefixes/:id',  authenticate, isAdmin, validate(updateLandlinePrefixSchema), LandlinePrefixController.updateLandlinePrefix)
router.delete('/landline-prefixes/:id', authenticate, isAdmin, LandlinePrefixController.deleteLandlinePrefix)

export default router