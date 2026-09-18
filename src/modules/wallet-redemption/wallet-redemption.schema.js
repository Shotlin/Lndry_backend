/**
 * Wallet Redemption JSON Schemas.
 * Every response lists its fields explicitly — a lesson learned the hard
 * way during the Refer & Earn initiative, where an under-specified schema
 * under this app's global `removeAdditional: 'all'` AJV config silently
 * stripped every field of a response with nothing declared as "allowed."
 */

export const lookupPhoneSchema = {
  tags: ['Wallet Redemption'],
  summary: 'Look up a walk-in customer\'s real wallet balance by phone [VENDOR]',
  body: {
    type: 'object',
    required: ['phone'],
    properties: { phone: { type: 'string', minLength: 10, maxLength: 15 } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            name: { type: 'string' },
            balancePaise: { type: 'integer' },
          },
        },
      },
    },
  },
}

export const createRequestSchema = {
  tags: ['Wallet Redemption'],
  summary: 'Propose redeeming part of a customer\'s wallet balance against a counter sale [VENDOR]',
  body: {
    type: 'object',
    required: ['customerUserId', 'amountPaise'],
    properties: {
      customerUserId: { type: 'string', format: 'uuid' },
      amountPaise: { type: 'integer', minimum: 1 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            expiresAt: { type: 'string' },
          },
        },
      },
    },
  },
}

export const confirmRequestSchema = {
  tags: ['Wallet Redemption'],
  summary: 'Confirm a wallet redemption with the code the customer read off their app [VENDOR]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['otp'],
    properties: { otp: { type: 'string', minLength: 4, maxLength: 10 } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            amountPaise: { type: 'integer' },
            walletTransactionId: { type: 'string' },
            newBalance: { type: 'number' },
          },
        },
      },
    },
  },
}

export const cancelRequestSchema = {
  tags: ['Wallet Redemption'],
  summary: 'Abort a pending wallet redemption request [VENDOR]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: { cancelled: { type: 'boolean' } },
        },
      },
    },
  },
}

export const getPendingSchema = {
  tags: ['Wallet Redemption'],
  summary: 'This customer\'s own pending wallet redemption request, if any [CUSTOMER]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: ['object', 'null'],
          properties: {
            requestId: { type: 'string' },
            amountPaise: { type: 'integer' },
            vendorName: { type: 'string' },
            otp: { type: ['string', 'null'] },
            expiresAt: { type: 'string' },
            attemptsRemaining: { type: 'integer' },
          },
        },
      },
    },
  },
}
