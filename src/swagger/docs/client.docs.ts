export const clientPaths = {
  '/clients': {
    get: {
      tags: ['Clients'],
      summary: 'Get all clients',
      responses: {
        200: {
          description: 'List of clients',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Client' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Clients'],
      summary: 'Create a new client',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateClientRequest' },
            example: {
              first_name: 'Maria',
              last_name: 'Santos',
              middle_initial: 'L',
              suffix: null,
              username: 'mariasantos',
              email: 'maria@example.com',
              password: 'secret12345',
              phone: '09181234567',
              company_name: 'Santos Enterprises',
              billing_address: '123 Rizal Ave, Manila',
              payment_terms: 30,
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Client created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Client' },
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
  '/clients/{id}': {
    get: {
      tags: ['Clients'],
      summary: 'Get client by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '9cbf7585-fbc5-4239-a619-98713d5679c6' },
      ],
      responses: {
        200: {
          description: 'Client found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Client' },
                },
              },
            },
          },
        },
        404: { description: 'Client not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Clients'],
      summary: 'Update a client',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '9cbf7585-fbc5-4239-a619-98713d5679c6' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateClientRequest' },
            example: {
              first_name: 'Maria',
              last_name: 'Santos',
              email: 'maria@example.com',
              company_name: 'Santos Enterprises',
              billing_address: '123 Rizal Ave, Manila',
              payment_terms: 30,
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Client updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Client' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Client not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Clients'],
      summary: 'Delete a client',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: '9cbf7585-fbc5-4239-a619-98713d5679c6' },
      ],
      responses: {
        200: {
          description: 'Client deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Client deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Client not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}