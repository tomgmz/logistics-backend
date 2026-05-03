export const accountantPaths = {
  '/accountants': {
    get: {
      tags: ['Accountants'],
      summary: 'Get all accountants',
      responses: {
        200: {
          description: 'List of accountants',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Accountant' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Accountants'],
      summary: 'Create a new accountant',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateAccountantRequest' },
            example: {
              first_name: 'John',
              last_name: 'Doe',
              middle_name: null,
              suffix: null,
              username: 'johndoe',
              email: 'john@example.com',
              phone: '+639171234567',
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Accountant created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Accountant' },
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
  '/accountants/{id}': {
    get: {
      tags: ['Accountants'],
      summary: 'Get accountant by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'Accountant found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Accountant' },
                },
              },
            },
          },
        },
        404: { description: 'Accountant not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Accountants'],
      summary: 'Update an accountant',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateAccountantRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Accountant updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Accountant' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Accountant not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Accountants'],
      summary: 'Delete an accountant',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'Accountant deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Accountant deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Accountant not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}
