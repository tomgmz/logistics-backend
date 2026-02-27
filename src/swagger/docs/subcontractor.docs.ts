export const subcontractorPaths = {
  '/subcontractors': {
    get: {
      tags: ['Subcontractors'],
      summary: 'Get all subcontractors',
      responses: {
        200: {
          description: 'List of subcontractors',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Subcontractor' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Subcontractors'],
      summary: 'Create a new subcontractor',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateSubcontractorRequest' },
            example: {
              first_name: 'Pedro',
              last_name: 'Reyes',
              middle_initial: 'B',
              suffix: null,
              username: 'pedroreyes',
              email: 'pedro@example.com',
              password: 'secret12345',
              phone: '09171234567',
              subcontractor_type: 'company',
              company_name: 'Reyes Trucking Co.',
              business_permit: 'BP-2026-00123',
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Subcontractor created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Subcontractor' },
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
  '/subcontractors/{id}': {
    get: {
      tags: ['Subcontractors'],
      summary: 'Get subcontractor by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'edf523d7-5b55-4c00-b84d-a09e9cb72f8b' },
      ],
      responses: {
        200: {
          description: 'Subcontractor found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Subcontractor' },
                },
              },
            },
          },
        },
        404: { description: 'Subcontractor not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Subcontractors'],
      summary: 'Update a subcontractor',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'edf523d7-5b55-4c00-b84d-a09e9cb72f8b' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateSubcontractorRequest' },
            example: {
              first_name: 'Pedro',
              last_name: 'Reyes',
              email: 'pedro@example.com',
              phone: '09171234567',
              subcontractor_type: 'company',
              company_name: 'Reyes Trucking Co.',
              business_permit: 'BP-2026-00123',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Subcontractor updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Subcontractor' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Subcontractor not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Subcontractors'],
      summary: 'Delete a subcontractor',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'edf523d7-5b55-4c00-b84d-a09e9cb72f8b' },
      ],
      responses: {
        200: {
          description: 'Subcontractor deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Subcontractor deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Subcontractor not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}