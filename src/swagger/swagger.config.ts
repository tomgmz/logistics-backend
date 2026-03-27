import swaggerJsdoc from 'swagger-jsdoc'

//schemas
import { adminSchemas }             from './schemas/admin.schemas.js'
import { clientSchemas }            from './schemas/client.schemas.js'
import { driverSchemas }            from './schemas/driver.schemas.js'
import { helperSchemas }            from './schemas/helper.schemas.js'
import { subcontractorSchemas }     from './schemas/subcontractor.schemas.js'
import { truckSchemas }             from './schemas/truck.schema.js'
import { truckModelSchemas }        from './schemas/truck-model.schema.js'
import { bookingSchemas }           from './schemas/client/booking.schemas.js'
import { routeOptimizationSchemas } from './schemas/maps/routeOptimization.schema.js'
import { authSchemas } from './schemas/auth/auth.schema.js'


//paths
import { adminPaths }             from './docs/admin.docs.js'
import { clientPaths }            from './docs/client.docs.js'
import { driverPaths }            from './docs/driver.docs.js'
import { helperPaths }            from './docs/helper.docs.js'
import { subcontractorPaths }     from './docs/subcontractor.docs.js'
import { truckPaths }             from './docs/truck.docs.js'
import { truckModelPaths }        from './docs/truck-model.docs.js'
import { bookingPaths }           from './docs/client/booking.docs.js'
import { routeOptimizationPaths } from './docs/maps/routeOptimization.docs.js'
import { authPaths } from './docs/auth/auth.docs.js'

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title:       'Logistics Backend API',
      version:     '1.0.0',
      description: 'Logistics Backend REST API',
    },
    servers: [
      { url: 'https://logistics-backend.up.railway.app/api', description: 'Production' },
      { url: 'http://localhost:4000/api',                    description: 'Development' },
    ],
    tags: [
      { name: 'Admins',              description: 'Admin management' },
      { name: 'Drivers',             description: 'Driver management' },
      { name: 'Clients',             description: 'Client management' },
      { name: 'Helpers',             description: 'Helper management' },
      { name: 'Subcontractors',      description: 'Subcontractor management' },
      { name: 'Trucks',              description: 'Truck management' },
      { name: 'Truck Models',        description: 'Truck model catalogue management' },
      { name: 'Bookings',            description: 'Booking management' },
      { name: 'Route Optimization',  description: 'Google Maps route optimization and geocoding' },
      { name: 'Auth',  description: 'Authentication with OTP code' },
    ],
    paths: {
      ...adminPaths,
      ...clientPaths,
      ...driverPaths,
      ...helperPaths,
      ...subcontractorPaths,
      ...truckPaths,
      ...truckModelPaths,
      ...bookingPaths,
      ...routeOptimizationPaths,
      ...authPaths
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ...adminSchemas,
        ...clientSchemas,
        ...driverSchemas,
        ...helperSchemas,
        ...subcontractorSchemas,
        ...truckSchemas,
        ...truckModelSchemas,
        ...bookingSchemas,
        ...routeOptimizationSchemas,
        ...authSchemas,
      },
    },
  },
  apis: [],
}

export const swaggerSpec = swaggerJsdoc(options)