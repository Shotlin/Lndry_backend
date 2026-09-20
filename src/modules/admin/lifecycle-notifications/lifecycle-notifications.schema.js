const eventKey = { type: 'string', pattern: '^[A-Z][A-Z_]{2,58}$' }
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

// The app's Ajv config strips undeclared properties, so nested objects list every key.
const link = {
  type: 'object',
  nullable: true,
  properties: {
    type: { type: 'string', maxLength: 40 },
    params: { type: 'object', properties: { route: { type: 'string', maxLength: 200 } } },
  },
}

export const eventParamSchema = {
  params: { type: 'object', required: ['eventKey'], properties: { eventKey } },
}

export const saveEventSchema = {
  params: { type: 'object', required: ['eventKey'], properties: { eventKey } },
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 300 },
      body: { type: 'string', maxLength: 1000 },
      enabled: { type: 'boolean' },
      recipient_type: { type: 'string', enum: ['CUSTOMER', 'VENDOR', 'CAPTAIN'] },
      link,
      image_url: { type: 'string', maxLength: 2000, nullable: true },
    },
  },
}

export const previewSchema = {
  params: { type: 'object', required: ['eventKey'], properties: { eventKey } },
  body: {
    type: 'object',
    properties: { title: { type: 'string', maxLength: 300 }, body: { type: 'string', maxLength: 1000 } },
  },
}

export const testSchema = {
  params: { type: 'object', required: ['eventKey'], properties: { eventKey } },
  body: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', pattern: uuid } } },
}

export const logSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      event: { type: 'string', maxLength: 60 },
      status: { type: 'string', enum: ['PENDING', 'SENT', 'PARTIAL', 'FAILED', 'NO_DEVICE', 'SKIPPED'] },
      order: { type: 'string', maxLength: 60 },
    },
  },
}
