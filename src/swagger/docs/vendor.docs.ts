export const vendorPaths = {
  '/vendors': {
    get: {
      tags: ['Vendors'],
      summary: 'Get all vendors',
      responses: {
        200: {
          description: 'List of vendors',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Vendor' } },
                },
              },
            },
          },
        },
        500: { description: 'Internal server error' },
      },
    },
    post: {
      tags: ['Vendors'],
      summary: 'Create a new vendor',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateVendorRequest' },
            example: {
              first_name: 'Pedro',
              last_name: 'Reyes',
              middle_initial: 'B',
              suffix: null,
              username: 'pedroreyes',
              email: 'pedro@example.com',
              password: 'secret12345',
              phone: '09171234567',
              vendor_type: 'company',
              company_name: 'Reyes Trucking Co.',
              business_permit: 'BP-2026-00123',
              created_by: null,
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Vendor created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Vendor' },
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
  '/vendors/{id}': {
    get: {
      tags: ['Vendors'],
      summary: 'Get vendor by ID',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'edf523d7-5b55-4c00-b84d-a09e9cb72f8b' },
      ],
      responses: {
        200: {
          description: 'Vendor found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Vendor' },
                },
              },
            },
          },
        },
        404: { description: 'Vendor not found' },
        500: { description: 'Internal server error' },
      },
    },
    patch: {
      tags: ['Vendors'],
      summary: 'Update a vendor',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'edf523d7-5b55-4c00-b84d-a09e9cb72f8b' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateVendorRequest' },
            example: {
              first_name: 'Pedro',
              last_name: 'Reyes',
              email: 'pedro@example.com',
              phone: '09171234567',
              vendor_type: 'company',
              company_name: 'Reyes Trucking Co.',
              business_permit: 'BP-2026-00123',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Vendor updated successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/Vendor' },
                },
              },
            },
          },
        },
        400: { description: 'Validation error' },
        404: { description: 'Vendor not found' },
        500: { description: 'Internal server error' },
      },
    },
    delete: {
      tags: ['Vendors'],
      summary: 'Delete a vendor',
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, example: 'edf523d7-5b55-4c00-b84d-a09e9cb72f8b' },
      ],
      responses: {
        200: {
          description: 'Vendor deleted successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Vendor deleted successfully' },
                },
              },
            },
          },
        },
        404: { description: 'Vendor not found' },
        500: { description: 'Internal server error' },
      },
    },
  },
}