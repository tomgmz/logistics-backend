export const routeOptimizationSchemas = {
  GeocodeRequest: {
    type: 'object',
    required: ['address'],
    properties: {
      address: { type: 'string', minLength: 1, example: '123 Katipunan Ave, Quezon City' },
    },
  },
  GeocodeResponse: {
    type: 'object',
    properties: {
      address:   { type: 'string',  example: '123 Katipunan Ave, Quezon City' },
      latitude:  { type: 'number',  example: 14.6333 },
      longitude: { type: 'number',  example: 121.0437 },
    },
  },
  OptimizedStop: {
    type: 'object',
    properties: {
      destination_id:            { type: 'string', format: 'uuid',   example: '550e8400-e29b-41d4-a716-446655440000' },
      address:                   { type: 'string',                    example: '123 Katipunan Ave, Quezon City' },
      latitude:                  { type: 'number',                    example: 14.6333 },
      longitude:                 { type: 'number',                    example: 121.0437 },
      optimized_sequence_order:  { type: 'integer',                   example: 1 },
    },
  },
  OptimizeRouteResponse: {
    type: 'object',
    properties: {
      booking_id:  { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
      total_stops: { type: 'integer', example: 3 },
      origin: {
        type: 'object',
        properties: {
          address:   { type: 'string',  example: 'Laguna Warehouse' },
          latitude:  { type: 'number',  example: 14.1678 },
          longitude: { type: 'number',  example: 121.2416 },
        },
      },
      optimized_stops: {
        type: 'array',
        items: { $ref: '#/components/schemas/OptimizedStop' },
      },
    },
  },
}