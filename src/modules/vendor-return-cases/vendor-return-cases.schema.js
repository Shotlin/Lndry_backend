const caseProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  orderId: { type: 'string' },
  customerUserId: { type: 'string' },
  amountPaise: { type: 'integer' },
  reason: { type: 'string' },
  note: { type: ['string', 'null'] },
  status: { type: 'string' },
  decisionNote: { type: ['string', 'null'] },
  decidedAt: { type: ['string', 'null'] },
  decidedBy: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const requestReturnCaseSchema = {
  tags: ['Vendor Return Cases'],
  summary: 'Request a refund/return case on an order [VENDOR]',
  body: {
    type: 'object',
    required: ['orderId', 'amountPaise', 'reason'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
      amountPaise: { type: 'integer', minimum: 1 },
      reason: { type: 'string', enum: ['QUALITY_ISSUE', 'SERVICE_NOT_PERFORMED', 'DUPLICATE_CHARGE', 'CUSTOMER_CANCELLATION', 'OTHER'] },
      note: { type: 'string', maxLength: 1000 },
    },
  },
  response: { 200: envelope({ type: 'object', properties: caseProperties }), 201: envelope({ type: 'object', properties: caseProperties }) },
}

export const decideReturnCaseSchema = {
  tags: ['Vendor Return Cases'],
  summary: 'Approve or reject a requested return case [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['approve', 'decisionNote'], properties: { approve: { type: 'boolean' }, decisionNote: { type: 'string', maxLength: 1000 } } },
  response: { 200: envelope({ type: 'object', properties: caseProperties }) },
}

export const listReturnCasesSchema = {
  tags: ['Vendor Return Cases'],
  summary: "This vendor's return cases [VENDOR]",
  querystring: { type: 'object', properties: { status: { type: 'string', enum: ['REQUESTED', 'APPROVED', 'REJECTED'] }, page: { type: 'integer' }, limit: { type: 'integer' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: caseProperties } }) },
}
