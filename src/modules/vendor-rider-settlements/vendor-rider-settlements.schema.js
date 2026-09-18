const settlementProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  riderEmployeeId: { type: 'string' },
  settlementDate: { type: 'string' },
  amountPaise: { type: 'integer' },
  method: { type: 'string' },
  status: { type: 'string' },
  orderIds: { type: 'array', items: { type: 'string' } },
  reference: { type: ['string', 'null'] },
  notes: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const listRiderSettlementsSchema = {
  tags: ['Vendor Rider Settlements'],
  summary: "This vendor's rider settlements [VENDOR]",
  querystring: {
    type: 'object',
    properties: { riderEmployeeId: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, page: { type: 'integer' }, limit: { type: 'integer' } },
  },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: settlementProperties } }) },
}

const settlementBodyProperties = {
  riderEmployeeId: { type: 'string', format: 'uuid' },
  settlementDate: { type: 'string', format: 'date' },
  amountPaise: { type: 'integer', minimum: 1 },
  method: { type: 'string', enum: ['CASH', 'UPI', 'BANK'] },
  orderIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
  reference: { type: 'string', maxLength: 120 },
  notes: { type: 'string', maxLength: 500 },
}

export const createRiderSettlementSchema = {
  tags: ['Vendor Rider Settlements'],
  summary: 'Record a cash/UPI/bank handover settlement with a rider [VENDOR]',
  body: { type: 'object', required: ['riderEmployeeId', 'amountPaise'], properties: settlementBodyProperties },
  response: { 201: envelope({ type: 'object', properties: settlementProperties }) },
}

export const updateRiderSettlementSchema = {
  tags: ['Vendor Rider Settlements'],
  summary: 'Edit a pending or handed-over rider settlement [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', properties: settlementBodyProperties },
  response: { 200: envelope({ type: 'object', properties: settlementProperties }) },
}

export const setRiderSettlementStatusSchema = {
  tags: ['Vendor Rider Settlements'],
  summary: 'Move a rider settlement to its next status [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['HANDED_OVER', 'RECONCILED', 'REJECTED'] } } },
  response: { 200: envelope({ type: 'object', properties: settlementProperties }) },
}
