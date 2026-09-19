/**
 * Account Deletion JSON Schemas
 *
 * Response fields must be listed explicitly — anything undeclared is dropped by
 * the serializer.
 */

const customerRequestProperties = {
  id:                  { type: 'string' },
  status:              { type: 'string' },
  reason:              { type: ['string', 'null'] },
  requestedAt:         { type: 'string' },
  reviewedAt:          { type: ['string', 'null'] },
  reviewNote:          { type: ['string', 'null'] },
  scheduledDeletionAt: { type: ['string', 'null'] },
  completedAt:         { type: ['string', 'null'] },
}

const adminRequestProperties = {
  ...customerRequestProperties,
  userId:           { type: 'string' },
  customerName:     { type: ['string', 'null'] },
  customerPhone:    { type: ['string', 'null'] },
  reviewedByName:   { type: ['string', 'null'] },
  walletBalance:    { type: 'number' },
  activeOrderCount: { type: 'integer' },
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}

const oneRequestResponse = (properties) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties },
  },
})

export const requestAccountDeletionSchema = {
  tags: ['Customer Profile'],
  summary: 'Request deletion of my account (admin approval required)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    properties: { reason: { type: 'string', maxLength: 500 } },
  },
  response: { 201: oneRequestResponse(customerRequestProperties) },
}

export const myAccountDeletionSchema = {
  tags: ['Customer Profile'],
  summary: 'Status of my account deletion request',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: ['object', 'null'], properties: customerRequestProperties },
      },
    },
  },
}

export const listAccountDeletionSchema = {
  tags: ['Account Deletion'],
  summary: 'Account deletion requests [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED'] },
      search: { type: 'string', maxLength: 100 },
      page:   { type: 'integer', minimum: 1, default: 1 },
      limit:  { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: adminRequestProperties } },
        pagination: {
          type: 'object',
          properties: {
            page:       { type: 'integer' },
            limit:      { type: 'integer' },
            total:      { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
        counts: {
          type: 'object',
          properties: {
            PENDING:   { type: 'integer' },
            APPROVED:  { type: 'integer' },
            REJECTED:  { type: 'integer' },
            COMPLETED: { type: 'integer' },
          },
        },
      },
    },
  },
}

const decisionBody = {
  type: 'object',
  properties: { note: { type: 'string', maxLength: 500 } },
}

export const approveAccountDeletionSchema = {
  tags: ['Account Deletion'],
  summary: 'Approve a deletion request — deactivates the account and starts the 30-day period [ADMIN]',
  params: idParams,
  body: decisionBody,
  response: { 200: oneRequestResponse(customerRequestProperties) },
}

export const rejectAccountDeletionSchema = {
  tags: ['Account Deletion'],
  summary: 'Reject a deletion request — the account stays active [ADMIN]',
  params: idParams,
  body: decisionBody,
  response: { 200: oneRequestResponse(customerRequestProperties) },
}
