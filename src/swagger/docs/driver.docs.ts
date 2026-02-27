export const driverPaths = {
  '/drivers': {
    get: {
      tags: ['Drivers'],
      summary: 'Get all drivers',
      responses: {
        200: {
          description: 'List of drivers',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Driver' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Drivers'],
      summary: 'Create a new driver',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateDriverRequest' },
            example: {
              first_name: 'Tom Ervin',
              last_name: 'Gomez',
              middle_initial: null,
              suffix: null,
              username: 'tomgz',
              email: 'tomervingmz@gmail.com',
              password: 'secret12345',
              phone: '+639171234567',
              license_number: 'N01-12-123456',
              license_expiry: '2027-12-31',
              is_subcontractor_driver: false,
              subcontractor_id: null,
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Driver created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Driver' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        500: { description: 'Internal server error' },
      },
    },
  },
  '/drivers/{id}': {
    get: {
      tags: ['Drivers'],
      summary: 'Get driver by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'ade09b28-6f8a-48d4-8d42-5a11bdfdae56' },
      ],
      responses: {
        200: {
          description: 'Driver found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Driver' },
                },
              },
            },
          },
        },
        404: { description: 'Driver not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Drivers'],
      summary: 'Update a driver',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'ade09b28-6f8a-48d4-8d42-5a11bdfdae56' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateDriverRequest' },
            example: {
              first_name: 'Tom Ervin',
              last_name: 'Gomez',
              license_number: 'N01-12-999999',
              license_expiry: '2028-12-31',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Driver updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Driver' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Driver not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Drivers'],
      summary: 'Delete a driver',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'ade09b28-6f8a-48d4-8d42-5a11bdfdae56' },
      ],
      responses: {
        200: {
          description: 'Driver deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Driver deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Driver not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}