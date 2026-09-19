const itemProperties = {
  id: { type: 'string' },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  minThreshold: { type: 'integer' },
  unit: { type: 'string' },
  isLowStock: { type: 'boolean' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const item = { type: 'object', properties: itemProperties }

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

const MAX_QTY = 10_000_000
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}

export const listInventorySchema = {
  response: { 200: envelope({ type: 'array', items: item }) },
}

export const createInventorySchema = {
  body: {
    type: 'object',
    required: ['name', 'quantity', 'minThreshold', 'unit'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      quantity: { type: 'integer', minimum: 0, maximum: MAX_QTY },
      minThreshold: { type: 'integer', minimum: 0, maximum: MAX_QTY },
      unit: { type: 'string', minLength: 1, maxLength: 30 },
    },
  },
  response: { 201: envelope(item) },
}

export const updateInventorySchema = {
  params: idParams,
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      quantity: { type: 'integer', minimum: 0, maximum: MAX_QTY },
      minThreshold: { type: 'integer', minimum: 0, maximum: MAX_QTY },
      unit: { type: 'string', minLength: 1, maxLength: 30 },
    },
  },
  response: { 200: envelope(item) },
}

export const adjustInventorySchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['delta'],
    additionalProperties: false,
    properties: { delta: { type: 'integer', minimum: -MAX_QTY, maximum: MAX_QTY } },
  },
  response: { 200: envelope(item) },
}

export const removeInventorySchema = {
  params: idParams,
  response: { 200: envelope({ type: ['object', 'null'] }) },
}
