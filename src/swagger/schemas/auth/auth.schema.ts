export const authSchemas = {
  RequestOtpRequest: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email', example: 'admin@logistics.com' },
    },
  },
  VerifyOtpRequest: {
    type: 'object',
    required: ['email', 'code'],
    properties: {
      email:       { type: 'string', format: 'email', example: 'admin@logistics.com' },
      code:        { type: 'string', minLength: 6, maxLength: 6, example: '482910' },
      device_info: { type: 'string', nullable: true, example: 'Chrome on Windows' },
    },
  },
  AuthResponse: {
    type: 'object',
    properties: {
      token:   { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
      expires: { type: 'string', format: 'date-time', example: '2026-04-03T08:00:00.000Z' },
      user:    { $ref: '#/components/schemas/AuthUser' },
    },
  },
  AuthUser: {
    type: 'object',
    properties: {
      user_id:    { type: 'string', format: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
      email:      { type: 'string', format: 'email', example: 'admin@logistics.com' },
      first_name: { type: 'string', nullable: true, example: 'Juan' },
      last_name:  { type: 'string', nullable: true, example: 'dela Cruz' },
      role:       { type: 'string', enum: ['admin', 'super_admin', 'client', 'driver', 'vendor'], example: 'client' },
      status:     { type: 'string', enum: ['active', 'inactive', 'archived'], example: 'active' },
      clients: {
        type: 'object',
        nullable: true,
        properties: {
          client_id:       { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
          company_name:    { type: 'string', nullable: true, example: 'Santos Enterprises' },
          billing_address: { type: 'string', nullable: true, example: '123 Rizal Ave, Manila' },
          payment_terms:   { type: 'integer', nullable: true, example: 30 },
        },
      },
    },
  },
}