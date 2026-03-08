import swaggerJsdoc from 'swagger-jsdoc'
import { adminSchemas } from './schemas/admin.schemas.js'
import { clientSchemas } from './schemas/client.schemas.js'
import { driverSchemas } from './schemas/driver.schemas.js'
import { helperSchemas } from './schemas/helper.schemas.js'
import { subcontractorSchemas } from './schemas/subcontractor.schemas.js'
import { truckSchemas } from './schemas/truck.schema.js'
import { bookingSchemas } from './schemas/client/booking.schemas.js'
import { adminPaths } from './docs/admin.docs.js'
import { clientPaths } from './docs/client.docs.js'
import { driverPaths } from './docs/driver.docs.js'
import { helperPaths } from './docs/helper.docs.js'
import { subcontractorPaths } from './docs/subcontractor.docs.js'
import { truckPaths } from './docs/truck.docs.js'
import { bookingPaths } from './docs/client/booking.docs.js'

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Logistics Backend API',
      version: '1.0.0',
      description: 'Logistics Backend REST API',
    },
    servers: [
      { url: 'https://logistics-backend.up.railway.app/api', description: 'Production' },
      { url: 'http://localhost:4000/api',                    description: 'Development' },
    ],
    tags: [
      { name: 'Admins',         description: 'Admin management' },
      { name: 'Drivers',        description: 'Driver management' },
      { name: 'Clients',        description: 'Client management' },
      { name: 'Helpers',        description: 'Helper management' },
      { name: 'Subcontractors', description: 'Subcontractor management' },
      { name: 'Trucks', description: 'Truck management' },
      { name: 'Bookings', description: 'Booking management' },
    ],
    paths: {
      ...adminPaths,
      ...clientPaths,
      ...driverPaths,
      ...helperPaths,
      ...subcontractorPaths,
      ...truckPaths,
      ...bookingPaths,
    },
    components: {
      schemas: {
        ...adminSchemas,
        ...clientSchemas,
        ...driverSchemas,
        ...helperSchemas,
        ...subcontractorSchemas,
        ...truckSchemas,
        ...bookingSchemas,
      },
    },
  },
  apis: [],
}

export const swaggerSpec = swaggerJsdoc(options)