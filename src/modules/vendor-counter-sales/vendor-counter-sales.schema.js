const lineInputProperties = {
  vendorServiceRateId: { type: 'string', format: 'uuid' },
  quantity: { type: 'number', minimum: 0.01 },
}

const pricedLineProperties = {
  vendorServiceRateId: { type: 'string' },
  garmentName: { type: 'string' },
  serviceName: { type: 'string' },
  qty: { type: 'number' },
  ratePaise: { type: 'integer' },
  amountPaise: { type: 'integer' },
  unit: { type: 'string' },
}

const quoteProperties = {
  lines: { type: 'array', items: { type: 'object', properties: pricedLineProperties } },
  subtotalPaise: { type: 'integer' },
  chargesPaise: { type: 'integer' },
  discountsPaise: { type: 'integer' },
  totalPaise: { type: 'integer' },
}

const orderProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  customerUserId: { type: 'string' },
  posOrderId: { type: 'string' },
  orderNumber: { type: ['string', 'null'] },
  items: { type: 'array' },
  subtotalPaise: { type: 'integer' },
  discountPaise: { type: 'integer' },
  taxPaise: { type: 'integer' },
  totalPaise: { type: 'integer' },
  paymentMethod: { type: ['string', 'null'] },
  cashShiftId: { type: ['string', 'null'] },
  placedAt: { type: 'string' },
  createdAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const quoteCounterSaleSchema = {
  tags: ['Vendor Counter Sales'],
  summary: 'Price a walk-in sale without booking it [VENDOR]',
  body: {
    type: 'object',
    required: ['lines'],
    properties: {
      lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['vendorServiceRateId', 'quantity'], properties: lineInputProperties } },
      chargeRuleIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      discountRuleIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  },
  response: { 200: envelope({ type: 'object', properties: quoteProperties }) },
}

export const bookCounterSaleSchema = {
  tags: ['Vendor Counter Sales'],
  summary: 'Book (ring up) a completed walk-in sale [VENDOR]',
  body: {
    type: 'object',
    required: ['customerUserId', 'lines', 'paymentMode'],
    properties: {
      customerUserId: { type: 'string', format: 'uuid' },
      lines: { type: 'array', minItems: 1, items: { type: 'object', required: ['vendorServiceRateId', 'quantity'], properties: lineInputProperties } },
      chargeRuleIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      discountRuleIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      paymentMode: { type: 'string', enum: ['CASH', 'UPI', 'CARD', 'BANK', 'PAY_LATER'] },
      cashRegister: { type: 'string', maxLength: 80 },
      idempotencyKey: { type: 'string', maxLength: 100 },
    },
  },
  response: {
    201: envelope({
      type: 'object',
      properties: { order: { type: 'object', properties: orderProperties }, quote: { type: 'object', properties: quoteProperties } },
    }),
  },
}
