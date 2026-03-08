export const bookingSchemas = {
  CreateBookingRequest: {
    type: 'object',
    required: ['client_id', 'origin', 'truck_type_needed', 'schedule_date', 'call_time', 'destinations'],
    properties: {
      client_id:          { type: 'string', format: 'uuid',   example: '550e8400-e29b-41d4-a716-446655440000' },
      origin:             { type: 'string',                    example: 'Laguna Warehouse' },
      truck_type_needed:  { type: 'string',                    example: '10-wheeler' },
      cargo_details:      { type: 'string', nullable: true,    example: 'Fragile electronics' },
      schedule_date:      { type: 'string', format: 'date',    example: '2027-01-15' },
      call_time:          { type: 'string',                    example: '08:00' },
      destinations: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['address', 'sequence_order'],
          properties: {
            address:        { type: 'string', example: '123 Katipunan Ave, QC' },
            sequence_order: { type: 'integer', example: 1 },
            notes:          { type: 'string', nullable: true, example: 'Call before delivery' },
          },
        },
      },
    },
  },
  UpdateBookingRequest: {
    type: 'object',
    properties: {
      origin:             { type: 'string', example: 'Laguna Warehouse' },
      truck_type_needed:  { type: 'string', example: '10-wheeler' },
      cargo_details:      { type: 'string', nullable: true, example: 'Fragile electronics' },
      schedule_date:      { type: 'string', format: 'date', example: '2027-01-15' },
      call_time:          { type: 'string', example: '08:00' },
      status:             { type: 'string', enum: ['pending', 'assigned', 'in_transit', 'completed', 'cancelled'], example: 'assigned' },
    },
  },
  UpdateBookingStatusRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['pending', 'assigned', 'in_transit', 'completed', 'cancelled'], example: 'in_transit' },
    },
  },
  UpdateDestinationRequest: {
    type: 'object',
    properties: {
      address:        { type: 'string', example: '123 Katipunan Ave, QC' },
      sequence_order: { type: 'integer', example: 1 },
      status:         { type: 'string', enum: ['pending', 'delivered', 'failed'], example: 'delivered' },
      delivered_at:   { type: 'string', format: 'date-time', nullable: true, example: '2027-01-15T14:30:00Z' },
      notes:          { type: 'string', nullable: true, example: 'Call before delivery' },
    },
  },
  UpdateDestinationStatusRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status:       { type: 'string', enum: ['pending', 'delivered', 'failed'], example: 'delivered' },
      delivered_at: { type: 'string', format: 'date-time', nullable: true, example: '2027-01-15T14:30:00Z' },
    },
  },
  BookingDestination: {
    type: 'object',
    properties: {
      destination_id: { type: 'string', format: 'uuid',      example: '550e8400-e29b-41d4-a716-446655440000' },
      booking_id:     { type: 'string', format: 'uuid',      example: '550e8400-e29b-41d4-a716-446655440000' },
      address:        { type: 'string',                       example: '123 Katipunan Ave, QC' },
      sequence_order: { type: 'integer',                      example: 1 },
      status:         { type: 'string', enum: ['pending', 'delivered', 'failed'], example: 'pending' },
      delivered_at:   { type: 'string', format: 'date-time', nullable: true, example: null },
      notes:          { type: 'string', nullable: true,       example: 'Call before delivery' },
      created_at:     { type: 'string', format: 'date-time', example: '2026-02-26T12:05:24.518177' },
    },
  },
  Booking: {
    type: 'object',
    properties: {
      booking_id:         { type: 'string', format: 'uuid',   example: '550e8400-e29b-41d4-a716-446655440000' },
      client_id:          { type: 'string', format: 'uuid',   example: '550e8400-e29b-41d4-a716-446655440000' },
      origin:             { type: 'string',                    example: 'Laguna Warehouse' },
      truck_type_needed:  { type: 'string',                    example: '10-wheeler' },
      cargo_details:      { type: 'string', nullable: true,    example: 'Fragile electronics' },
      schedule_date:      { type: 'string', format: 'date',    example: '2027-01-15' },
      call_time:          { type: 'string',                    example: '08:00' },
      status:             { type: 'string', enum: ['pending', 'assigned', 'in_transit', 'completed', 'cancelled'], example: 'pending' },
      created_at:         { type: 'string', format: 'date-time', example: '2026-02-26T12:05:24.518177' },
      updated_at:         { type: 'string', format: 'date-time', example: '2026-02-26T12:05:24.518177' },
      booking_destinations: {
        type: 'array',
        items: { $ref: '#/components/schemas/BookingDestination' },
      },
      client: {
        type: 'object',
        properties: {
          client_id:      { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
          company_name:   { type: 'string', nullable: true, example: 'Acme Corp' },
          billing_address:{ type: 'string', nullable: true, example: '123 Main St, Manila' },
          payment_terms:  { type: 'integer',                example: 30 },
          user: {
            type: 'object',
            properties: {
              first_name: { type: 'string', example: 'Juan' },
              last_name:  { type: 'string', example: 'dela Cruz' },
              email:      { type: 'string', example: 'juan@example.com' },
              phone:      { type: 'string', nullable: true, example: '09171234567' },
            },
          },
        },
      },
    },
  },
}