export const truckModelPaths = {
  '/truck-models': {
    get: {
      tags: ['Truck Models'],
      summary: 'Get all truck models',
      responses: {
        200: {
          description: 'List of truck models',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/TruckModel' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Truck Models'],
      summary: 'Create a new truck model',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateTruckModelRequest' },
            example: {
              name:               'Wing Van 40ft',
              body_type:          'Wing Van',
              dimension_mm:       '12192 x 2438 x 2591',
              suitable_for:       'Dry goods, electronics, garments',
              stackable_friendly: true,
              max_volume_cbm:     67.5,
              max_weight_kg:      15000,
              max_length_cm:      1219.2,
              image_url:          'https://example.com/images/wing-van-40ft.png',
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Truck model created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/TruckModel' },
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
  '/truck-models/{id}': {
    get: {
      tags: ['Truck Models'],
      summary: 'Get truck model by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      ],
      responses: {
        200: {
          description: 'Truck model found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/TruckModel' },
                },
              },
            },
          },
        },
        404: { description: 'Truck model not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Truck Models'],
      summary: 'Update a truck model',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateTruckModelRequest' },
            example: {
              max_weight_kg:      18000,
              stackable_friendly: false,
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Truck model updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/TruckModel' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Truck model not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Truck Models'],
      summary: 'Delete a truck model',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      ],
      responses: {
        200: {
          description: 'Truck model deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status:  { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Truck model deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Truck model not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}