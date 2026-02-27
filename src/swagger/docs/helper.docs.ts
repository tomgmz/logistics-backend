export const helperPaths = {
  '/helpers': {
    get: {
      tags: ['Helpers'],
      summary: 'Get all helpers',
      responses: {
        200: {
          description: 'List of helpers',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Helper' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Helpers'],
      summary: 'Create a new helper',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateHelperRequest' },
            example: {
              first_name: 'Carlo',
              last_name: 'Mendoza',
              middle_initial: null,
              suffix: null,
              username: 'carlomendoza',
              email: 'carlo@example.com',
              password: 'secret12345',
              phone: '09201234567',
              license_number: 'N01-12-654321',
              license_expiry: '2027-12-31',
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Helper created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Helper' },
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
  '/helpers/{id}': {
    get: {
      tags: ['Helpers'],
      summary: 'Get helper by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '8a50d256-2811-49ec-935f-638597aba410' },
      ],
      responses: {
        200: {
          description: 'Helper found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Helper' },
                },
              },
            },
          },
        },
        404: { description: 'Helper not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Helpers'],
      summary: 'Update a helper',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '8a50d256-2811-49ec-935f-638597aba410' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateHelperRequest' },
            example: {
              first_name: 'Carlo',
              last_name: 'Mendoza',
              phone: '09201234567',
              license_number: 'N01-12-654321',
              license_expiry: '2028-12-31',
              driver_status: 'available',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Helper updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Helper' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Helper not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Helpers'],
      summary: 'Delete a helper',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '8a50d256-2811-49ec-935f-638597aba410' },
      ],
      responses: {
        200: {
          description: 'Helper deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Helper deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Helper not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}