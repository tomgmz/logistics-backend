import { Router } from 'express'
import { validate }                  from '../middlewares/validate.middleware.js'
import { lockGuard, fromParam }      from '../lib/record-lock.js'
import { authenticate, authorize, isRootAdmin }   from '../middlewares/auth.middleware.js'
import { createAdminSchema, updateAdminSchema }                       from '../schema/admin/admin.schema.js'
import { createClientSchema, updateClientSchema }                     from '../schema/admin/client.schema.js'
import { createDriverSchema, updateDriverSchema }                     from '../schema/admin/driver.schema.js'
import { createTruckSchema, updateTruckSchema, recordTruckInspectionSchema } from '../schema/admin/truck.schema.js'
import { createTruckModelSchema, updateTruckModelSchema }             from '../schema/admin/truck-model.schema.js'
import { createGeneralManagerSchema, updateGeneralManagerSchema }     from '../schema/admin/general_manager.schema.js'
import { createFleetAdminSchema, updateFleetAdminSchema }             from '../schema/admin/admin_roles.schema.js'
import { createOperationsAdminSchema, updateOperationsAdminSchema }   from '../schema/admin/admin_roles.schema.js'
import { createITAdminSchema, updateITAdminSchema, transitionITAdminSchema }   from '../schema/admin/it-admin.schema.js'
import { assignBookingSchema, updateDeliveryStatusSchema } from '../schema/admin/assignment.schema.js'
import * as AdminController           from '../controllers/admin/admin.controller.js'
import * as ClientController          from '../controllers/admin/client.controller.js'
import * as DriverController          from '../controllers/admin/driver.controller.js'
import * as TruckController           from '../controllers/admin/truck.controller.js'
import * as TruckModelController      from '../controllers/admin/truck-model.controller.js'
import * as GeneralManagerController  from '../controllers/admin/general_manager.controller.js'
import * as FleetAdminController      from '../controllers/admin/fleet_admin.controller.js'
import * as OperationsAdminController from '../controllers/admin/operations_admin.controller.js'
import * as ITAdminController from '../controllers/admin/it-admin.controller.js'
import * as AssignmentController from '../controllers/admin/assignment.controller.js'
import * as TripController from '../controllers/client/trip.controller.js'
import * as ReportController from '../controllers/driver/report.controller.js'
import { setTripPlanSchema } from '../schema/client/trip.schema.js'
import { setReportStatusSchema } from '../schema/driver/report.schema.js'
import * as UserController from '../controllers/admin/fetch-users.controller.js'
import * as PasswordResetController from '../controllers/admin/password-reset.controller.js'
import * as ExternalDriverController from '../controllers/admin/external-driver.controller.js'
import { requireModuleFlag } from '../middlewares/moduleAccess.middleware.js'
import * as AuditLogController from '../controllers/admin/audit-logs.controller.js'
import * as SystemLogController from '../controllers/admin/system-logs.controller.js'
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
// System logs are IT Admin's alone — deliberately narrower than isAdmin.
const isItAdmin = authorize('it_admin')
const isFleet      = authorize('admin', 'it_admin', 'fleet_manager', 'general_manager', 'client')
const isOperations = authorize('admin', 'it_admin', 'operations_manager', 'general_manager', 'client')
// Read-only view of drivers/trucks for operations (needed to populate the
// assignment dropdowns). CRUD stays restricted to isFleet.
const isFleetRead  = authorize('admin', 'it_admin', 'fleet_manager', 'general_manager', 'client', 'operations_manager')
// Releasing a driver's reservation: whoever owns the fleet plus operations, who
// are the ones the stuck driver disappears on. Not clients — they have no
// business moving a driver between pools.
const isCrewRelease = authorize('admin', 'it_admin', 'fleet_manager', 'general_manager', 'operations_manager')

//Admins — admin / it_admin only
router.get('/admins',        authenticate, isAdmin, AdminController.getAllAdmins)
router.get('/admins/:id',    authenticate, isAdmin, AdminController.getAdminById)
router.post('/admins',       authenticate, isAdmin, validate(createAdminSchema), AdminController.createAdmin)
router.patch('/admins/:id',  authenticate, isAdmin, lockGuard('user', fromParam('id')), validate(updateAdminSchema), AdminController.updateAdmin)
router.patch('/admins/:id/deactivate', authenticate, isAdmin, lockGuard('user', fromParam('id')), AdminController.deactivateAdmin)
router.patch('/admins/:id/activate',   authenticate, isAdmin, lockGuard('user', fromParam('id')), AdminController.activateAdmin)
router.delete('/admins/:id', authenticate, isAdmin, lockGuard('user', fromParam('id')), AdminController.deleteAdmin)

//Clients
router.get('/clients',        authenticate, isOperations, ClientController.getAllClients)
router.get('/clients/:id',    authenticate, isOperations, ClientController.getClientById)
router.post('/clients',       authenticate, isAdmin,  validate(createClientSchema), ClientController.createClient)
router.patch('/clients/:id',  authenticate, isAdmin,  lockGuard('user', fromParam('id')), validate(updateClientSchema), ClientController.updateClient)
router.patch('/clients/:id/deactivate', authenticate, isAdmin, lockGuard('user', fromParam('id')), ClientController.deactivateClient)
router.patch('/clients/:id/activate',   authenticate, isAdmin, lockGuard('user', fromParam('id')), ClientController.activateClient)
router.delete('/clients/:id', authenticate, isAdmin,  lockGuard('user', fromParam('id')), ClientController.deleteClient)

// Drivers
router.get('/drivers',                     authenticate, isFleetRead, DriverController.getAllDrivers)
router.post('/drivers/scan-license',       authenticate, isFleet, uploadSingle, DriverOCRController.scanDriverLicense)
// Who can be crewed onto a booking scheduled for ?date — the driver calendar
// decides, so this cannot be answered without one. Before /:id so 'assignable'
// is never read as a driver id.
router.get('/drivers/assignable',          authenticate, isFleetRead, DriverController.getAssignableDrivers)
router.get('/drivers/:id',                 authenticate, isFleetRead, DriverController.getDriverById)
router.post('/drivers',                    authenticate, isFleet, uploadSingle, validate(createDriverSchema), DriverController.createDriver)
router.patch('/drivers/:id',               authenticate, isFleet, lockGuard('user', fromParam('id')), validate(updateDriverSchema), DriverController.updateDriver)
router.patch('/drivers/:id/deactivate',    authenticate, isFleet, lockGuard('user', fromParam('id')), DriverController.deactivateDriver)
router.patch('/drivers/:id/activate',      authenticate, isFleet, lockGuard('user', fromParam('id')), DriverController.activateDriver)
// Recovery hatch for a driver left reserved against a delivery that is gone.
// Operations is included because they are the ones who hit the wall — the driver
// silently drops out of the assignment dropdowns and cannot put themselves back.
router.patch('/drivers/:id/stand-down',    authenticate, isCrewRelease, lockGuard('user', fromParam('id')), DriverController.standDownDriver)
router.delete('/drivers/:id',              authenticate, isFleet, lockGuard('user', fromParam('id')), DriverController.deleteDriver)

//Assignments
router.get('/assignments',                    authenticate, isOperations, AssignmentController.getAllAssignments)
router.get('/assignments/:bookingId',         authenticate, isOperations, AssignmentController.getAssignmentByBooking)
router.get('/assignments/:bookingId/history', authenticate, isOperations, AssignmentController.getAssignmentHistory)
router.post('/assignments/:bookingId',        authenticate, isOperations, lockGuard('booking', fromParam('bookingId')), validate(assignBookingSchema), AssignmentController.assignBooking)
router.patch('/assignments/:bookingId/status', authenticate, isOperations, lockGuard('booking', fromParam('bookingId')), validate(updateDeliveryStatusSchema), AssignmentController.updateDeliveryStatus)

// How many runs the assigned vehicle makes, and which drop-offs each run serves.
// One truck that shuttles, not several trucks — see the booking_trips migration.
// GET creates the default plan (one run over every drop-off) if none was set, so
// a booking assigned before this existed still opens in the driver app.
//
// Staff-only, NOT isOperations: that list admits 'client', and these routes have
// no per-client scoping — a client on it could read and re-plan any booking in
// the system, not merely their own. isCrewRelease is the crewing audience
// (admin, IT, fleet, GM, operations) and nobody else.
router.get('/assignments/:bookingId/trips',  authenticate, isCrewRelease, TripController.getTrips)
router.put('/assignments/:bookingId/trips',  authenticate, isCrewRelease, lockGuard('booking', fromParam('bookingId')), validate(setTripPlanSchema), TripController.setTripPlan)

// Incidents raised by drivers from the road. Fleet own the vehicle and
// operations own the delivery, so both read this queue.
router.get('/driver-reports',                 authenticate, isFleetRead, ReportController.listAllReports)
router.get('/driver-reports/:reportId',       authenticate, isFleetRead, ReportController.getReport)
router.patch('/driver-reports/:reportId/status', authenticate, isCrewRelease, lockGuard('driver_report', fromParam('reportId')), validate(setReportStatusSchema), ReportController.setReportStatus)

// Trucks
router.get('/trucks',        authenticate, isFleetRead, TruckController.getAllTrucks)
router.get('/trucks/:id',    authenticate, isFleetRead, TruckController.getTruckById)
// BLOWBAGETS inspections live on the VEHICLE: the fleet manager records them
// here, and only a vehicle whose latest inspection passed can be picked by
// operations. Read is open to the same roles that can read the fleet so the
// assignment UI can show readiness.
router.get('/trucks/:id/inspections',  authenticate, isFleetRead, TruckController.getTruckInspections)
router.post('/trucks/:id/inspections', authenticate, isFleet, lockGuard('truck', fromParam('id')), validate(recordTruckInspectionSchema), TruckController.recordTruckInspection)
router.post('/trucks',       authenticate, isFleet, validate(createTruckSchema), TruckController.createTruck)
router.patch('/trucks/:id',  authenticate, isFleet, lockGuard('truck', fromParam('id')), validate(updateTruckSchema), TruckController.updateTruck)
router.delete('/trucks/:id', authenticate, isFleet, lockGuard('truck', fromParam('id')), TruckController.deleteTruck)

//Truck Models
router.get('/truck-models',        authenticate, isFleet, TruckModelController.getAllTruckModels)
router.get('/truck-models/:id',    authenticate, isFleet, TruckModelController.getTruckModelById)
router.post('/truck-models',       authenticate, isFleet, validate(createTruckModelSchema), TruckModelController.createTruckModel)
router.patch('/truck-models/:id',  authenticate, isFleet, lockGuard('truck_model', fromParam('id')), validate(updateTruckModelSchema), TruckModelController.updateTruckModel)
router.delete('/truck-models/:id', authenticate, isFleet, lockGuard('truck_model', fromParam('id')), TruckModelController.deleteTruckModel)


//General Managers
router.get('/general-managers',        authenticate, isAdmin, GeneralManagerController.getAllGeneralManagers)
router.get('/general-managers/:id',    authenticate, isAdmin, GeneralManagerController.getGeneralManagerById)
router.post('/general-managers',       authenticate, isAdmin, validate(createGeneralManagerSchema), GeneralManagerController.createGeneralManager)
router.patch('/general-managers/:id',  authenticate, isAdmin, lockGuard('user', fromParam('id')), validate(updateGeneralManagerSchema), GeneralManagerController.updateGeneralManager)
router.patch('/general-managers/:id/deactivate', authenticate, isAdmin, lockGuard('user', fromParam('id')), GeneralManagerController.deactivateGeneralManager)
router.patch('/general-managers/:id/activate',   authenticate, isAdmin, lockGuard('user', fromParam('id')), GeneralManagerController.activateGeneralManager)
router.delete('/general-managers/:id', authenticate, isAdmin, lockGuard('user', fromParam('id')), GeneralManagerController.deleteGeneralManager)

//Fleet Admins — isAdmin manages, isFleet can view
router.get('/fleet-admins',        authenticate, isFleet,      FleetAdminController.getAllFleetAdmins)
router.get('/fleet-admins/:id',    authenticate, isFleet,      FleetAdminController.getFleetAdminById)
router.post('/fleet-admins',       authenticate, isAdmin, validate(createFleetAdminSchema), FleetAdminController.createFleetAdmin)
router.patch('/fleet-admins/:id',  authenticate, isAdmin, lockGuard('user', fromParam('id')), validate(updateFleetAdminSchema), FleetAdminController.updateFleetAdmin)
router.patch('/fleet-admins/:id/deactivate', authenticate, isAdmin, lockGuard('user', fromParam('id')), FleetAdminController.deactivateFleetAdmin)
router.patch('/fleet-admins/:id/activate',   authenticate, isAdmin, lockGuard('user', fromParam('id')), FleetAdminController.activateFleetAdmin)
router.delete('/fleet-admins/:id', authenticate, isAdmin, lockGuard('user', fromParam('id')), FleetAdminController.deleteFleetAdmin)

//Operations Admins — isAdmin manages, isOperations can view
router.get('/operations-admins',        authenticate, isOperations, OperationsAdminController.getAllOperationsAdmins)
router.get('/operations-admins/:id',    authenticate, isOperations, OperationsAdminController.getOperationsAdminById)
router.post('/operations-admins',       authenticate, isAdmin,  validate(createOperationsAdminSchema), OperationsAdminController.createOperationsAdmin)
router.patch('/operations-admins/:id',  authenticate, isAdmin,  lockGuard('user', fromParam('id')), validate(updateOperationsAdminSchema), OperationsAdminController.updateOperationsAdmin)
router.patch('/operations-admins/:id/deactivate', authenticate, isAdmin, lockGuard('user', fromParam('id')), OperationsAdminController.deactivateOperationsAdmin)
router.patch('/operations-admins/:id/activate',   authenticate, isAdmin, lockGuard('user', fromParam('id')), OperationsAdminController.activateOperationsAdmin)
router.delete('/operations-admins/:id', authenticate, isAdmin,  lockGuard('user', fromParam('id')), OperationsAdminController.deleteOperationsAdmin)

//IT Admins
router.get('/it-admins',        authenticate, isAdmin, ITAdminController.getAllITAdmins)
router.get('/it-admins/:id',    authenticate, isAdmin, ITAdminController.getITAdminById)
router.post('/it-admins',       authenticate, isAdmin, validate(createITAdminSchema), ITAdminController.createITAdmin)
// Handing the role to a successor is narrower than the rest of this group: only
// the root admin, never an IT Admin. A resigning office-holder must not be able
// to appoint their own replacement, and `isAdmin` above would let them.
router.post('/it-admins/transition', authenticate, authorize('admin'), isRootAdmin, validate(transitionITAdminSchema), ITAdminController.transitionITAdmin)
router.patch('/it-admins/:id',  authenticate, isAdmin, lockGuard('user', fromParam('id')), validate(updateITAdminSchema), ITAdminController.updateITAdmin)
router.patch('/it-admins/:id/deactivate', authenticate, isAdmin, lockGuard('user', fromParam('id')), ITAdminController.deactivateITAdmin)
router.patch('/it-admins/:id/activate',   authenticate, isAdmin, lockGuard('user', fromParam('id')), ITAdminController.activateITAdmin)
router.delete('/it-admins/:id', authenticate, isAdmin, lockGuard('user', fromParam('id')), ITAdminController.deleteITAdmin)

//Fetch all users
router.get('/users',       authenticate, isAdmin, UserController.getUsers)
router.get('/users/stats', authenticate, isAdmin, UserController.getUserStats)

// Password reset queues. Both admin roles reach these routes; which REQUESTS each
// one may act on is enforced in the service (admin handles drivers + clients,
// it_admin handles staff), because authorize() cannot express that split.
router.get('/password-resets',             authenticate, isAdmin, PasswordResetController.listRequests)
router.post('/password-resets/:id/send',   authenticate, isAdmin, lockGuard('password_reset', fromParam('id')), PasswordResetController.sendLink)
router.patch('/password-resets/:id/cancel', authenticate, isAdmin, lockGuard('password_reset', fromParam('id')), PasswordResetController.cancelRequest)

// App access for vendor-supplied drivers.
//
// Operations sits alongside the admin roles here because ops is who assigns the
// driver in the first place, and a subcontractor whose phone died mid-run needs
// a new setup link from the person looking at the booking, not an escalation.
// Revocation is the same group: the fastest offboarding is the one the
// dispatcher can do the moment a vendor is stood down.
router.get('/external-drivers/:userId/access',   authenticate, isCrewRelease, ExternalDriverController.getAccessStatus)
router.post('/external-drivers/:userId/reinvite', authenticate, isCrewRelease, lockGuard('user', fromParam('userId')), ExternalDriverController.reinvite)
router.post('/external-drivers/:userId/revoke',   authenticate, isCrewRelease, lockGuard('user', fromParam('userId')), ExternalDriverController.revoke)

//Module permissions (RBAC) — managed by admin / it_admin
router.get('/users/:id/permissions', authenticate, isAdmin, PermissionsController.getUserPermissions)
router.put('/users/:id/permissions', authenticate, isAdmin, lockGuard('user', fromParam('id')), validate(replacePermissionsSchema), PermissionsController.setUserPermissions)

// Audit logs — the business trail. Company Admin and IT Admin can both READ it
// (IT Admin is who investigates), and neither can write or delete: rows are
// only ever inserted by logEvent().
router.get('/audit-logs',        authenticate, isAdmin, AuditLogController.getAllLogs)
router.get('/audit-logs/stats',  authenticate, isAdmin, AuditLogController.getLogStats)
// An export is a GET, which moduleGuard maps to can_view, so the export tier
// has to be named here or it would mean nothing. Registered before /:id.
router.get('/audit-logs/export', authenticate, isAdmin, requireModuleFlag('audit-logs', 'can_export'), AuditLogController.exportLogs)
router.get('/audit-logs/:id',    authenticate, isAdmin, AuditLogController.getLogById)

// System logs — the technical trail. IT Admin ONLY. Stack traces, provider
// error codes and internals are not the Company Admin's to read, which is why
// these do not sit behind isAdmin like the audit routes above.
router.get('/system-logs',              authenticate, isItAdmin, SystemLogController.getAllLogs)
router.get('/system-logs/stats',        authenticate, isItAdmin, SystemLogController.getLogStats)
router.get('/system-logs/export',       authenticate, isItAdmin, SystemLogController.exportLogs)
router.get('/system-logs/:id',          authenticate, isItAdmin, SystemLogController.getLogById)
router.patch('/system-logs/:id/resolve', authenticate, isItAdmin, SystemLogController.setResolved)

//upload
router.post('/upload/image', authenticate, isFleet, uploadSingle, UploadController.uploadImage)

// Handling Codes
router.get('/handling-codes',        authenticate, isOperations, CargoCatalogController.getAllHandlingCodes)
router.get('/handling-codes/:id',    authenticate, isOperations, CargoCatalogController.getHandlingCodeById)
router.post('/handling-codes',       authenticate, isOperations, validate(createHandlingCodeSchema), CargoCatalogController.createHandlingCode)
router.patch('/handling-codes/:id',  authenticate, isOperations, lockGuard('handling_code', fromParam('id')), validate(updateHandlingCodeSchema), CargoCatalogController.updateHandlingCode)
router.delete('/handling-codes/:id', authenticate, isOperations, lockGuard('handling_code', fromParam('id')), CargoCatalogController.deleteHandlingCode)

// Commodities
router.get('/commodities',        authenticate, isOperations, CargoCatalogController.getAllCommodities)
router.get('/commodities/:id',    authenticate, isOperations, CargoCatalogController.getCommodityById)
router.post('/commodities',       authenticate, isOperations, validate(createCommoditySchema), CargoCatalogController.createCommodity)
router.patch('/commodities/:id',  authenticate, isOperations, lockGuard('commodity', fromParam('id')), validate(updateCommoditySchema), CargoCatalogController.updateCommodity)
router.delete('/commodities/:id', authenticate, isOperations, lockGuard('commodity', fromParam('id')), CargoCatalogController.deleteCommodity)

// Products — supports ?commodity_id= filter on GET /products
router.get('/products',        authenticate, isOperations, CargoCatalogController.getAllProducts)
router.get('/products/:id',    authenticate, isOperations, CargoCatalogController.getProductById)
router.post('/products',       authenticate, isOperations, validate(createProductSchema), CargoCatalogController.createProduct)
router.patch('/products/:id',  authenticate, isOperations, lockGuard('product', fromParam('id')), validate(updateProductSchema), CargoCatalogController.updateProduct)
router.delete('/products/:id', authenticate, isOperations, lockGuard('product', fromParam('id')), CargoCatalogController.deleteProduct)

//landline prefixes
router.get('/landline-prefixes',        authenticate, isOperations, LandlinePrefixController.getAllLandlinePrefixes)
router.get('/landline-prefixes/:id',    authenticate, isOperations, LandlinePrefixController.getLandlinePrefixById)
router.post('/landline-prefixes',       authenticate, isAdmin, validate(createLandlinePrefixSchema), LandlinePrefixController.createLandlinePrefix)
router.patch('/landline-prefixes/:id',  authenticate, isAdmin, lockGuard('landline_prefix', fromParam('id')), validate(updateLandlinePrefixSchema), LandlinePrefixController.updateLandlinePrefix)
router.delete('/landline-prefixes/:id', authenticate, isAdmin, lockGuard('landline_prefix', fromParam('id')), LandlinePrefixController.deleteLandlinePrefix)

export default router