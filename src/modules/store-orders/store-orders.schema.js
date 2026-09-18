/**
 * Store Orders JSON Schemas.
 */

const storeOrderItemProperties = {
  name: { type: 'string' },
  serviceName: { type: 'string' },
  qty: { type: 'number' },
  unit: { type: 'string' },
  ratePaise: { type: 'integer' },
  amountPaise: { type: 'integer' },
}

const storeOrderProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  vendorName: { type: 'string' },
  customerUserId: { type: 'string' },
  posOrderId: { type: 'string' },
  orderNumber: { type: ['string', 'null'] },
  items: { type: 'array', items: { type: 'object', properties: storeOrderItemProperties } },
  subtotalPaise: { type: 'integer' },
  discountPaise: { type: 'integer' },
  taxPaise: { type: 'integer' },
  totalPaise: { type: 'integer' },
  paymentMethod: { type: ['string', 'null'] },
  placedAt: { type: 'string' },
  createdAt: { type: 'string' },
}

export const resolvePhoneSchema = {
  tags: ['Store Orders'],
  summary: 'Resolve a walk-in customer\'s phone to a real LNDRY account [VENDOR]',
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
          properties: { userId: { type: 'string' }, name: { type: 'string' } },
        },
      },
    },
  },
}

export const pushStoreOrderSchema = {
  tags: ['Store Orders'],
  summary: 'Record a completed counter sale for a real customer [VENDOR]',
  body: {
    type: 'object',
    required: ['customerUserId', 'posOrderId', 'totalPaise'],
    properties: {
      customerUserId: { type: 'string', format: 'uuid' },
      posOrderId: { type: 'string', minLength: 1, maxLength: 100 },
      orderNumber: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: storeOrderItemProperties } },
      subtotalPaise: { type: 'integer', minimum: 0 },
      discountPaise: { type: 'integer', minimum: 0 },
      taxPaise: { type: 'integer', minimum: 0 },
      totalPaise: { type: 'integer', minimum: 0 },
      paymentMethod: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object', properties: storeOrderProperties },
      },
    },
  },
}

export const listMyStoreOrdersSchema = {
  tags: ['Store Orders'],
  summary: 'This customer\'s own walk-in "Laundry Store" order history',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: storeOrderProperties } },
      },
    },
  },
}
