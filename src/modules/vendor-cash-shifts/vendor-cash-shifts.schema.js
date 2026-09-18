const shiftProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  register: { type: 'string' },
  status: { type: 'string' },
  businessDate: { type: 'string' },
  openingCashPaise: { type: 'integer' },
  openedBy: { type: 'string' },
  openedAt: { type: 'string' },
  note: { type: ['string', 'null'] },
  countedCashPaise: { type: ['integer', 'null'] },
  expectedCashPaise: { type: ['integer', 'null'] },
  variancePaise: { type: ['integer', 'null'] },
  varianceApprovedBy: { type: ['string', 'null'] },
  closeNote: { type: ['string', 'null'] },
  closedBy: { type: ['string', 'null'] },
  closedAt: { type: ['string', 'null'] },
  createdAt: { type: 'string' },
  collectionsPaise: { type: 'integer' },
  expensesPaise: { type: 'integer' },
  collectionCount: { type: 'integer' },
  expenseCount: { type: 'integer' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const getCurrentCashShiftSchema = {
  tags: ['Vendor Cash Shifts'],
  summary: "This register's currently open cash shift, if any [VENDOR]",
  querystring: { type: 'object', properties: { register: { type: 'string' } } },
  response: { 200: envelope({ type: ['object', 'null'], properties: shiftProperties }) },
}

export const listCashShiftsSchema = {
  tags: ['Vendor Cash Shifts'],
  summary: 'Cash shift history for this vendor [VENDOR]',
  querystring: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: shiftProperties } }) },
}

export const openCashShiftSchema = {
  tags: ['Vendor Cash Shifts'],
  summary: 'Open a new counter cash shift [VENDOR]',
  body: {
    type: 'object',
    required: ['openingCashPaise'],
    properties: {
      register: { type: 'string', maxLength: 80 },
      openingCashPaise: { type: 'integer', minimum: 0 },
      note: { type: 'string', maxLength: 500 },
    },
  },
  response: { 201: envelope({ type: 'object', properties: shiftProperties }) },
}

export const closeCashShiftSchema = {
  tags: ['Vendor Cash Shifts'],
  summary: 'Close an open cash shift with a counted cash amount [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: {
    type: 'object',
    required: ['countedCashPaise'],
    properties: {
      countedCashPaise: { type: 'integer', minimum: 0 },
      note: { type: 'string', maxLength: 500 },
      supervisorApproved: { type: 'boolean' },
      supervisorActor: { type: 'string', maxLength: 160 },
    },
  },
  response: { 200: envelope({ type: 'object', properties: shiftProperties }) },
}
