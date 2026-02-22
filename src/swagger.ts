import swaggerJsdoc from 'swagger-jsdoc'

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
        url: 'http://localhost:4000/api',
        description: 'Development',
      },
    ],
    tags: [
      { name: 'Drivers', description: 'Driver management' },
      // { name: 'Clients', description: 'Client management' },
      // { name: 'Subcontractors', description: 'Subcontractor management' },
    ],
    components: {
      schemas: {
        CreateDriverRequest: {
          type: 'object',
          required: ['first_name', 'last_name', 'username', 'email', 'password', 'license_number', 'license_expiry'],
          properties: {
            first_name:               { type: 'string', minLength: 2, maxLength: 50, example: 'Juan' },
            last_name:                { type: 'string', minLength: 2, maxLength: 50, example: 'dela Cruz' },
            middle_initial:           { type: 'string', maxLength: 1, nullable: true, example: 'A' },
            suffix:                   { type: 'string', maxLength: 10, nullable: true, example: 'Jr.' },
            username:                 { type: 'string', minLength: 2, maxLength: 50, example: 'juandc' },
            email:                    { type: 'string', format: 'email', example: 'juan@example.com' },
            password:                 { type: 'string', format: 'password', minLength: 8, example: 'secret12345' },
            phone:                    { type: 'string', maxLength: 13, example: '+639171234567' },
            created_by:               { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
            license_number:           { type: 'string', maxLength: 50, example: 'N01-12-123456' },
            license_expiry:           { type: 'string', example: '2027-12-31' },
            is_subcontractor_driver:  { type: 'boolean', example: false },
            subcontractor_id:         { type: 'string', format: 'uuid', nullable: true, example: '550e8400-e29b-41d4-a716-446655440000' },
          },
        },
        UpdateDriverRequest: {
          type: 'object',
          properties: {
            first_name:               { type: 'string', minLength: 2, maxLength: 50, example: 'Juan' },
            last_name:                { type: 'string', minLength: 2, maxLength: 50, example: 'dela Cruz' },
            middle_initial:           { type: 'string', maxLength: 1, nullable: true, example: 'A' },
            suffix:                   { type: 'string', maxLength: 10, nullable: true, example: 'Jr.' },
            phone:                    { type: 'string', maxLength: 13, example: '+639171234567' },
            license_number:           { type: 'string', maxLength: 50, example: 'N01-12-123456' },
            license_expiry:           { type: 'string', example: '2027-12-31' },
            is_subcontractor_driver:  { type: 'boolean', example: false },
            subcontractor_id:         { type: 'string', format: 'uuid', nullable: true, example: '550e8400-e29b-41d4-a716-446655440000' },
          },
        },
        Driver: {
          type: 'object',
          properties: {
            user_id:                  { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
            username:                 { type: 'string', example: 'juandc' },
            email:                    { type: 'string', example: 'juan@example.com' },
            first_name:               { type: 'string', example: 'Juan' },
            last_name:                { type: 'string', example: 'dela Cruz' },
            middle_initial:           { type: 'string', nullable: true, example: 'A' },
            suffix:                   { type: 'string', nullable: true, example: 'Jr.' },
            phone:                    { type: 'string', nullable: true, example: '+639171234567' },
            role:                     { type: 'string', example: 'driver' },
            status:                   { type: 'string', example: 'active' },
            created_at:               { type: 'string', format: 'date-time' },
            updated_at:               { type: 'string', format: 'date-time' },
            license_number:           { type: 'string', example: 'N01-12-123456' },
            license_expiry:           { type: 'string', example: '2027-12-31' },
            is_subcontractor_driver:  { type: 'boolean', example: false },
            subcontractor_id:         { type: 'string', format: 'uuid', nullable: true },
          },
        },
      },
    },
  },
  apis: ['./src/routes/**/*.ts'],
}

export const swaggerSpec = swaggerJsdoc(options)