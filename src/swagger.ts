import swaggerJsdoc from 'swagger-jsdoc'
import { adminSchemas } from './swagger/schemas/admin.schemas.js'
import { clientSchemas } from './swagger/schemas/client.schemas.js'
import { driverSchemas } from './swagger/schemas/driver.schemas.js'
import { helperSchemas } from './swagger/schemas/helper.schemas.js'
import { subcontractorSchemas } from './swagger/schemas/subcontractor.schemas.js'

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Logistics Backend API',
      version: '1.0.0',
      description: 'Logistics Backend REST API',
    },
    servers: [
      {
        url: 'https://logistics-backend.up.railway.app/api',
        description: 'Production',
      },
      {
        url: 'http://localhost:4000/api',
        description: 'Development',
      },
    ],
    tags: [
      { name: 'Admins',         description: 'Admin management' },
      { name: 'Drivers',        description: 'Driver management' },
      { name: 'Clients',        description: 'Client management' },
      { name: 'Helpers', description: 'Helper management' },
      { name: 'Subcontractors', description: 'Subcontractor management' },
    ],
    components: {
      schemas: {
        ...adminSchemas,
        ...clientSchemas,
        ...driverSchemas,
        ...helperSchemas,
        ...subcontractorSchemas,
      },
    },
  },
  apis: ['./src/routes/**/*.ts'],
}

export const swaggerSpec = swaggerJsdoc(options)