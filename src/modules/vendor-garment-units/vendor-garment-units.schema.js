const unitProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  orderId: { type: 'string' },
  orderLineId: { type: 'string' },
  customerUserId: { type: 'string' },
  garmentTypeId: { type: 'string' },
  sequence: { type: 'integer' },
  activeTagCode: { type: 'string' },
  state: { type: 'string' },
  location: { type: 'string' },
  condition: { type: 'string' },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
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

const tagHistoryProperties = {
  id: { type: 'string' },
  tagCode: { type: 'string' },
  status: { type: 'string' },
  issuedAt: { type: 'string' },
  issuedBy: { type: 'string' },
  retiredAt: { type: ['string', 'null'] },
  retiredBy: { type: ['string', 'null'] },
  retirementReason: { type: ['string', 'null'] },
  replacementTagId: { type: ['string', 'null'] },
  version: { type: 'integer' },
}

const unitDetailProperties = { ...unitProperties, events: { type: 'array', items: { type: 'object', properties: eventProperties } }, tagHistory: { type: 'array', items: { type: 'object', properties: tagHistoryProperties } } }

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const generateGarmentUnitsSchema = {
  tags: ['Vendor Garment Units'],
  summary: 'Generate physical garment tags for a piece-billed order line [VENDOR]',
  body: {
    type: 'object',
    required: ['orderLineId'],
    properties: { orderLineId: { type: 'string', format: 'uuid' }, count: { type: 'integer', minimum: 1, maximum: 500 } },
  },
  response: { 201: envelope({ type: 'array', items: { type: 'object', properties: unitProperties } }) },
}

export const listGarmentUnitsForOrderSchema = {
  tags: ['Vendor Garment Units'],
  summary: 'List garment units for an order [VENDOR]',
  params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: unitProperties } }) },
}

export const getGarmentUnitSchema = {
  tags: ['Vendor Garment Units'],
  summary: 'Garment unit detail with event and tag history [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'object', properties: unitDetailProperties }) },
}

export const scanGarmentUnitSchema = {
  tags: ['Vendor Garment Units'],
  summary: 'Scan a garment tag and optionally move it to a new state [VENDOR]',
  body: {
    type: 'object',
    required: ['tagCode'],
    properties: {
      tagCode: { type: 'string', maxLength: 40 },
      nextState: { type: 'string', enum: ['INTAKE', 'SORTED', 'PROCESSING', 'QC', 'REWASH', 'ASSEMBLY', 'RACKED', 'DISPATCHED', 'DELIVERED', 'MISSING', 'DAMAGED', 'CANCELLED'] },
      location: { type: 'string', maxLength: 80 },
      note: { type: 'string', maxLength: 500 },
      condition: { type: 'string', maxLength: 40 },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: { unit: { type: 'object', properties: unitDetailProperties }, scanResult: { type: 'string' } },
    }),
  },
}

const tagActionParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const reprintTagSchema = {
  tags: ['Vendor Garment Units'],
  summary: 'Log a same-identity tag reprint [VENDOR]',
  params: tagActionParams,
  body: { type: 'object', required: ['reason'], properties: { station: { type: 'string', maxLength: 80 }, reason: { type: 'string', maxLength: 240 } } },
  response: { 200: envelope({ type: 'object', properties: unitDetailProperties }) },
}

export const replaceTagSchema = {
  tags: ['Vendor Garment Units'],
  summary: 'Issue a new tag code for a garment unit (lost/damaged tag) [VENDOR]',
  params: tagActionParams,
  body: {
    type: 'object',
    required: ['reason'],
    properties: { station: { type: 'string', maxLength: 80 }, reason: { type: 'string', maxLength: 240 }, status: { type: 'string', enum: ['LOST', 'DAMAGED', 'REPLACED'] } },
  },
  response: { 200: envelope({ type: 'object', properties: unitDetailProperties }) },
}
