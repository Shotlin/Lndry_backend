const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const listOrdersSchema = {
  tags: ['Admin Orders'],
  summary: 'List all orders with filters',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string' },
      paymentMethod: { type: 'string' },
      search: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

export const statsByStatusSchema = { tags: ['Admin Orders'], summary: 'Order counts by status (tab badges)' }

export const orderDetailSchema = {
  tags: ['Admin Orders'],
  summary: 'Full order detail with items, timeline, payment, delivery',
  params: uuidParam,
}

export const updateStatusSchema = {
  tags: ['Admin Orders'],
  summary: 'Update order status with transition validation',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'] },
      note: { type: 'string', maxLength: 500 },
    },
  },
}

export const assignRiderSchema = {
  tags: ['Admin Orders'],
  summary: 'Assign rider to order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['riderId'],
    properties: { riderId: { type: 'string', format: 'uuid' } },
  },
}

export const bulkAssignSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk assign riders to orders',
  body: {
    type: 'object',
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['orderId', 'riderId'],
          properties: {
            orderId: { type: 'string', format: 'uuid' },
            riderId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  },
}

export const manualOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Create manual order on behalf of customer',
  body: {
    type: 'object',
    required: ['userId', 'items', 'deliveryAddress'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      items: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          required: ['productId', 'quantity'],
          properties: {
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1 },
          },
        },
      },
      paymentMethod: { type: 'string', enum: ['COD', 'MANUAL'], default: 'MANUAL' },
      deliveryAddress: { type: 'object' },
      couponCode: { type: 'string' },
    },
  },
}

export const invoiceSchema = { tags: ['Admin Orders'], summary: 'Download PDF invoice', params: uuidParam }
export const packingSlipSchema = { tags: ['Admin Orders'], summary: 'Get packing slip data', params: uuidParam }

export const exportSchema = {
  tags: ['Admin Orders'],
  summary: 'Export orders to CSV',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

export const refundOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Refund an order (credits wallet or initiates payment refund)',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      amount: { type: 'number', minimum: 0.01 },
      reason: { type: 'string', maxLength: 500 },
      refundTo: { type: 'string', enum: ['wallet', 'original', 'manual'], default: 'wallet' },
      method: { type: 'string', enum: ['WALLET', 'ORIGINAL'], default: 'WALLET' },
    },
  },
}

export const cancelOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Cancel an order with optional reason and refund',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 500 },
      refundTo: { type: 'string', enum: ['wallet', 'original', 'none'], default: 'wallet' },
    },
  },
}

export const bulkStatusSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk update status for multiple orders',
  body: {
    type: 'object',
    required: ['orderIds', 'status'],
    properties: {
      orderIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 },
      status: { type: 'string', enum: ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] },
    },
  },
}

