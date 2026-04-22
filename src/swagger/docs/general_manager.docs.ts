export const generalManagerPaths = {
  '/general-managers': {
    get: {
      tags: ['General Managers'],
      summary: 'Get all general managers',
      responses: {
        200: {
          description: 'List of general managers',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/GeneralManager' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['General Managers'],
      summary: 'Create a new general manager',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateGeneralManagerRequest' },
            example: {
              first_name: 'Jane',
              last_name: 'Smith',
              middle_initial: null,
              suffix: null,
              username: 'janesmith',
              email: 'jane@example.com',
              phone: '+639171234567',
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'General Manager created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/GeneralManager' },
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
  '/general-managers/{id}': {
    get: {
      tags: ['General Managers'],
      summary: 'Get general manager by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'General Manager found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/GeneralManager' },
                },
              },
            },
          },
        },
        404: { description: 'General Manager not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['General Managers'],
      summary: 'Update a general manager',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateGeneralManagerRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'General Manager updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/GeneralManager' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'General Manager not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['General Managers'],
      summary: 'Delete a general manager',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: {
          description: 'General Manager deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'General Manager deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'General Manager not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}
