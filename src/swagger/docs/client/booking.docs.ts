export const bookingPaths = {
  '/booking': {
    get: {
      tags: ['Bookings'],
      summary: 'Get all bookings',
      responses: {
        200: {
          description: 'List of bookings',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Booking' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Bookings'],
      summary: 'Create a new booking',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateBookingRequest' },
            example: {
              client_id: '550e8400-e29b-41d4-a716-446655440000',
              origin: 'Laguna Warehouse',
              truck_type_needed: '10-wheeler',
              cargo_details: 'Fragile electronics',
              schedule_date: '2027-01-15',
              call_time: '08:00',
              destinations: [
                { address: '123 Katipunan Ave, QC', sequence_order: 1, notes: 'Call before delivery' },
                { address: '456 Espana Blvd, Manila', sequence_order: 2 },
                { address: '789 Shaw Blvd, Mandaluyong', sequence_order: 3 },
              ],
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Booking created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Booking' },
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
  '/booking/{id}': {
    get: {
      tags: ['Bookings'],
      summary: 'Get booking by ID',
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'Booking found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Booking' },
                },
              },
            },
          },
        },
        404: { description: 'Booking not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Bookings'],
      summary: 'Update a booking',
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateBookingRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Booking updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Booking' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Booking not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Bookings'],
      summary: 'Delete a booking',
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'Booking deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Booking deleted successfully' },
                },
              },
            },
          },
        },
        400: { description: 'Cannot delete booking in transit' },
        404: { description: 'Booking not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
  '/booking/{id}/status': {
    patch: {
      tags: ['Bookings'],
      summary: 'Update booking status',
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateBookingStatusRequest' },
            example: { status: 'in_transit' },
          },
        },
      },
      responses: {
        200: {
          description: 'Booking status updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Booking' },
                },
              },
            },
          },
        },
        400: { description: 'Invalid status transition' },
        404: { description: 'Booking not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
  '/booking/client/{clientId}': {
    get: {
      tags: ['Bookings'],
      summary: 'Get bookings by client ID',
      parameters: [{ in: 'path', name: 'clientId', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'List of bookings for the client',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Booking' } },
                },
              },
            },
          },
        },
        404: { description: 'No bookings found' },
        500: { description: 'Internal server error' },
      },
    },
  },
  '/booking/{id}/destinations': {
    get: {
      tags: ['Bookings'],
      summary: 'Get all destinations for a booking',
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'List of destinations',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/BookingDestination' } },
                },
              },
            },
          },
        },
        404: { description: 'Booking not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
  '/booking/destinations/{destinationId}': {
    patch: {
      tags: ['Bookings'],
      summary: 'Update a destination',
      parameters: [{ in: 'path', name: 'destinationId', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateDestinationRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Destination updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/BookingDestination' },
                },
              },
            },
          },
        },
        404: { description: 'Destination not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Bookings'],
      summary: 'Delete a destination',
      parameters: [{ in: 'path', name: 'destinationId', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'Destination deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Destination deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Destination not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
  '/booking/destinations/{destinationId}/status': {
    patch: {
      tags: ['Bookings'],
      summary: 'Update destination status',
      parameters: [{ in: 'path', name: 'destinationId', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateDestinationStatusRequest' },
            example: { status: 'delivered', delivered_at: '2027-01-15T14:30:00Z' },
          },
        },
      },
      responses: {
        200: {
          description: 'Destination status updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/BookingDestination' },
                },
              },
            },
          },
        },
        404: { description: 'Destination not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}