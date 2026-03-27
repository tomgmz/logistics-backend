export const authPaths = {
  '/auth/request-otp': {
    post: {
      tags: ['Auth'],
      summary: 'Request a one-time login code',
      description: 'Sends a 6-digit OTP to the provided email. Always returns 200 regardless of whether the email exists.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/RequestOtpRequest' },
            example: { email: 'admin@logistics.com' },
          },
        },
      },
      responses: {
        200: {
          description: 'OTP sent (or silently ignored if email not found)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status:  { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'If that email is registered, a login code has been sent.' },
                },
              },
            },
          },
        },
        429: { description: 'Too many requests' },
        500: { description: 'Internal server error' },
      },
    },
  },

  '/auth/verify-otp': {
    post: {
      tags: ['Auth'],
      summary: 'Verify OTP and receive access token',
      description: 'Submits the 6-digit code. On success, all other sessions are revoked and a new JWT is returned.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/VerifyOtpRequest' },
            example: {
              email:       'admin@logistics.com',
              code:        '482910',
              device_info: 'Chrome on Windows',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Login successful',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data:   { $ref: '#/components/schemas/AuthResponse' },
                },
              },
            },
          },
        },
        401: { description: 'Invalid or expired code' },
        429: { description: 'Too many requests' },
        500: { description: 'Internal server error' },
      },
    },
  },

  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Logout and revoke current session',
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'Logged out successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status:  { type: 'string', example: 'success' },
                  message: { type: 'string', example: 'Logged out successfully' },
                },
              },
            },
          },
        },
        401: { description: 'Unauthorized' },
        500: { description: 'Internal server error' },
      },
    },
  },

  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Get current authenticated user',
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'Current user payload',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data:   { $ref: '#/components/schemas/AuthUser' },
                },
              },
            },
          },
        },
        401: { description: 'Unauthorized' },
        500: { description: 'Internal server error' },
      },
    },
  },
}