export const routeOptimizationPaths = {
  '/route-optimization/{bookingId}': {
    get: {
      tags: ['Route Optimization'],
      summary: 'Get existing optimized route',
      description: 'Returns the already-optimized stop order from the database. No Google API calls — safe to call on every map view.',
      parameters: [
        {
          in: 'path',
          name: 'bookingId',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          example: '550e8400-e29b-41d4-a716-446655440000',
        },
      ],
      responses: {
        200: {
          description: 'Optimized route retrieved successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data:   { $ref: '#/components/schemas/OptimizeRouteResponse' },
                },
              },
            },
          },
        },
        404: { description: 'Booking not found' },
        500: { description: 'Origin coordinates missing — booking may not have been optimized yet' },
      },
    },
  },
  '/route-optimization/optimize/{id}': {
    post: {
      tags: ['Route Optimization'],
      summary: 'Re-optimize booking route',
      description: 'Explicitly re-runs route optimization. Only needed when locations change after booking creation. On creation, optimization runs automatically.',
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          example: '550e8400-e29b-41d4-a716-446655440000',
        },
      ],
      responses: {
        200: {
          description: 'Route re-optimized successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data:   { $ref: '#/components/schemas/OptimizeRouteResponse' },
                },
              },
            },
          },
        },
        400: { description: 'Booking has no destinations or cannot be optimized' },
        404: { description: 'Booking not found' },
        500: { description: 'Internal server error or missing Google credentials' },
      },
    },
  },
  '/route-optimization/geocode': {
    post: {
      tags: ['Route Optimization'],
      summary: 'Geocode an address',
      description: 'Converts a text address to coordinates. Rarely needed since the frontend sends coordinates from Google Places.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/GeocodeRequest' },
            example: { address: '123 Katipunan Ave, Quezon City' },
          },
        },
      },
      responses: {
        200: {
          description: 'Address geocoded successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data:   { $ref: '#/components/schemas/GeocodeResponse' },
                },
              },
            },
          },
        },
        500: { description: 'Could not geocode address' },
      },
    },
  },
}