const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const listRidersSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      search: { type: 'string' },
      status: { type: 'string', enum: ['online', 'offline', 'pending', 'suspended'] },
      sortBy: { type: 'string', enum: ['created_at', 'name', 'deliveries', 'rating'], default: 'created_at' },
      sortOrder: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' },
    },
  },
}

export const riderIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const riderEarningsSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
    },
  },
}

export const createPayoutSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['amount', 'method'],
    properties: {
      amount: { type: 'number', minimum: 1 },
      method: { type: 'string', enum: ['BANK_TRANSFER', 'UPI', 'CASH'] },
      reference: { type: 'string', maxLength: 100 },
    },
  },
}

export const toggleSuspendSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['suspended'],
    properties: { suspended: { type: 'boolean' } },
  },
}

export const approveRiderSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['is_approved'],
    properties: { is_approved: { type: 'boolean' } },
  },
}

export const updateCommissionSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['rate'],
    properties: { rate: { type: 'number', minimum: 0, maximum: 100 } },
  },
}

export const verifyDocumentSchema = {
  params: {
    type: 'object',
    required: ['id', 'documentId'],
    properties: {
      id: { type: 'string', pattern: uuidPattern },
      documentId: { type: 'string', pattern: uuidPattern },
    },
  },
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
      note: { type: 'string', maxLength: 500 },
    },
  },
}
