export const adminPaths = {
  '/admins': {
    get: {
      tags: ['Admins'],
      summary: 'Get all admins',
      responses: {
        200: {
          description: 'List of admins',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Admin' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Admins'],
      summary: 'Create a new admin',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateAdminRequest' },
            example: {
              first_name: 'John',
              last_name: 'Doe',
              middle_name: 'A',
              suffix: null,
              email: 'john@example.com',
              phone: '+639171234567',
              role: 'admin',
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Admin created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Admin' },
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
  '/admins/{id}': {
    get: {
      tags: ['Admins'],
      summary: 'Get admin by ID',
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          example: '26429db4-6f20-4c60-b7dd-0063b6566c33',
        },
      ],
      responses: {
        200: {
          description: 'Admin found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Admin' },
                },
              },
            },
          },
        },
        404: { description: 'Admin not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Admins'],
      summary: 'Update an admin',
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          example: '26429db4-6f20-4c60-b7dd-0063b6566c33',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateAdminRequest' },
            example: {
              first_name: 'John',
              last_name: 'Doe',
              email: 'john@example.com',
              phone: '09171234567',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Admin updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Admin' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Admin not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Admins'],
      summary: 'Delete an admin',
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          example: '26429db4-6f20-4c60-b7dd-0063b6566c33',
        },
      ],
      responses: {
        200: {
          description: 'Admin deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Admin deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Admin not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}