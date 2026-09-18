const containerProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  orderId: { type: 'string' },
  customerUserId: { type: 'string' },
  tagCode: { type: 'string' },
  sequence: { type: 'integer' },
  totalCount: { type: 'integer' },
  weightKg: { type: ['number', 'null'] },
  state: { type: 'string' },
  location: { type: 'string' },
  condition: { type: 'string' },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
  deliveredAt: { type: ['string', 'null'] },
}

const eventProperties = {
  id: { type: 'string' },
  eventType: { type: 'string' },
  fromState: { type: ['string', 'null'] },
  toState: { type: ['string', 'null'] },
  location: { type: ['string', 'null'] },
  note: { type: ['string', 'null'] },
  actorId: { type: 'string' },
  createdAt: { type: 'string' },
}

const containerDetailProperties = { ...containerProperties, events: { type: 'array', items: { type: 'object', properties: eventProperties } } }

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const generateContainersSchema = {
  tags: ['Vendor Laundry Containers'],
  summary: 'Generate bag/container tags for a bulk (weight-based) order [VENDOR]',
  body: {
    type: 'object',
    required: ['orderId', 'count'],
    properties: { orderId: { type: 'string', format: 'uuid' }, count: { type: 'integer', minimum: 1, maximum: 500 }, weightKg: { type: 'number', minimum: 0 } },
  },
  response: { 201: envelope({ type: 'array', items: { type: 'object', properties: containerProperties } }) },
}

export const listContainersForOrderSchema = {
  tags: ['Vendor Laundry Containers'],
  summary: 'List bag/container tags for an order [VENDOR]',
  params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: containerProperties } }) },
}

export const getContainerSchema = {
  tags: ['Vendor Laundry Containers'],
  summary: 'Container detail with event history [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'object', properties: containerDetailProperties }) },
}

export const scanContainerSchema = {
  tags: ['Vendor Laundry Containers'],
  summary: 'Scan a bag/container tag and optionally move it to a new state [VENDOR]',
  body: {
    type: 'object',
    required: ['tagCode'],
    properties: {
      tagCode: { type: 'string', maxLength: 40 },
      nextState: { type: 'string', enum: ['INTAKE', 'PROCESSING', 'READY', 'DISPATCHED', 'DELIVERED', 'MISSING', 'DAMAGED', 'CANCELLED'] },
      location: { type: 'string', maxLength: 80 },
      note: { type: 'string', maxLength: 500 },
      condition: { type: 'string', maxLength: 40 },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: { container: { type: 'object', properties: containerDetailProperties }, scanResult: { type: 'string' } },
    }),
  },
}
