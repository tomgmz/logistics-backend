export const assistantDriverPaths = {
  '/assistant_drivers': {
    get: {
      tags: ['Assistant Drivers'],
      summary: 'Get all assistant drivers',
      responses: {
        200: {
          description: 'List of assistant drivers',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/AssistantDriver' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Assistant Drivers'],
      summary: 'Create a new assistant driver',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateAssistantDriverRequest' },
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
          description: 'Assistant driver created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/AssistantDriver' },
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
  '/assistant_drivers/{id}': {
    get: {
      tags: ['Assistant Drivers'],
      summary: 'Get assistant driver by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '8a50d256-2811-49ec-935f-638597aba410' },
      ],
      responses: {
        200: {
          description: 'Assistant driver found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/AssistantDriver' },
                },
              },
            },
          },
        },
        404: { description: 'Assistant driver not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Assistant Drivers'],
      summary: 'Update an assistant driver',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '8a50d256-2811-49ec-935f-638597aba410' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateAssistantDriverRequest' },
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
          description: 'Assistant driver updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/AssistantDriver' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Assistant driver not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Assistant Drivers'],
      summary: 'Delete an assistant driver',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '8a50d256-2811-49ec-935f-638597aba410' },
      ],
      responses: {
        200: {
          description: 'Assistant driver deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Assistant driver deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Assistant driver not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}