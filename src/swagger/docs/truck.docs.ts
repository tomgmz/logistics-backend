export const truckPaths = {
  '/trucks': {
    get: {
      tags: ['Trucks'],
      summary: 'Get all trucks',
      responses: {
        200: {
          description: 'List of trucks',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Truck' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Trucks'],
      summary: 'Create a new truck',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateTruckRequest' },
            example: {
              plate_number:     'ABC-1234',
              truck_type:       'Wing Van',
              capacity_tons:    10,
              owned_by:         'company',
              subcontractor_id: null,
              created_by:       null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Truck created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Truck' },
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
  '/trucks/{id}': {
    get: {
      tags: ['Trucks'],
      summary: 'Get truck by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      ],
      responses: {
        200: {
          description: 'Truck found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Truck' },
                },
              },
            },
          },
        },
        404: { description: 'Truck not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Trucks'],
      summary: 'Update a truck',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateTruckRequest' },
            example: {
              status:        'in_use',
              capacity_tons: 12,
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Truck updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Truck' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Truck not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Trucks'],
      summary: 'Delete a truck',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      ],
      responses: {
        200: {
          description: 'Truck deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Truck deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Truck not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}