const paymentOfferRow = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    provider: { type: 'string' },
    icon_url: { type: ['string', 'null'] },
    cashback_amount: { type: ['number', 'string'] },
    cashback_percent: { type: ['number', 'string', 'null'] },
    min_order_amount: { type: ['number', 'string'] },
    max_cashback: { type: ['number', 'string', 'null'] },
    lock_threshold: { type: ['number', 'string', 'null'] },
    is_active: { type: 'boolean' },
    valid_from: { type: 'string', format: 'date-time' },
    valid_until: { type: ['string', 'null'], format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
}

const paymentOfferWriteBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: ['string', 'null'], maxLength: 1000 },
    provider: { type: 'string', minLength: 1, maxLength: 50 },
    iconUrl: { type: ['string', 'null'] },
    cashbackAmount: { type: 'number', minimum: 0, maximum: 10000 },
    cashbackPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    minOrderAmount: { type: 'number', minimum: 0, maximum: 100000 },
    maxCashback: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
    lockThreshold: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
    isActive: { type: 'boolean' },
    validFrom: { type: ['string', 'null'], format: 'date-time' },
    validUntil: { type: ['string', 'null'], format: 'date-time' },
  },
}

export const getPaymentOffersSchema = {
  tags: ['Payment Offers'],
  summary: 'Get active payment offers with lock status',
  querystring: {
    type: 'object',
    properties: {
      cart_total: { type: 'number', minimum: 0, default: 0 },
      cartTotal: { type: 'number', minimum: 0 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              title: { type: 'string' },
              description: { type: ['string', 'null'] },
              provider: { type: 'string' },
              iconUrl: { type: ['string', 'null'] },
              cashbackAmount: { type: 'number' },
              minOrderAmount: { type: 'number' },
              isLocked: { type: 'boolean' },
              lockMessage: { type: ['string', 'null'] },
              unlockProgress: { type: 'number' },
            },
          },
        },
      },
    },
  },
}

export const getAdminPaymentOffersSchema = {
  tags: ['Payment Offers'],
  summary: 'List all payment offers [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: paymentOfferRow },
      },
    },
  },
}

export const createPaymentOfferSchema = {
  tags: ['Payment Offers'],
  summary: 'Create payment offer [ADMIN]',
  body: {
    ...paymentOfferWriteBody,
    required: ['title', 'provider', 'cashbackAmount'],
  },
}

export const updatePaymentOfferSchema = {
  tags: ['Payment Offers'],
  summary: 'Update payment offer [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    ...paymentOfferWriteBody,
    minProperties: 1,
  },
}

export const deletePaymentOfferSchema = {
  tags: ['Payment Offers'],
  summary: 'Delete payment offer [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}
