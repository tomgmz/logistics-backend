export const routeOptimizationPaths = {
  '/route-optimization/optimize/{id}': {
    post: {
      tags: ['Route Optimization'],
      summary: 'Optimize booking route',
      description: 'Geocodes all destinations in a booking and returns the optimal stop order using Google Routes Optimization API.',
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
          description: 'Route optimized successfully',
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
      description: 'Converts a text address to latitude and longitude coordinates using Google Geocoding API.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/GeocodeRequest' },
            example: {
              address: '123 Katipunan Ave, Quezon City',
            },
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