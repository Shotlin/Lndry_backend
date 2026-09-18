const expenseProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  expenseName: { type: 'string' },
  expenseDate: { type: 'string' },
  amountPaise: { type: 'integer' },
  category: { type: 'string' },
  paymentReceiver: { type: ['string', 'null'] },
  invoiceNumber: { type: ['string', 'null'] },
  isTaxPaid: { type: 'boolean' },
  paymentMode: { type: 'string' },
  cashShiftId: { type: ['string', 'null'] },
  notes: { type: ['string', 'null'] },
  attachmentUrl: { type: ['string', 'null'] },
  status: { type: 'string' },
  cancellationReason: { type: ['string', 'null'] },
  editReason: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

const expenseBodyProperties = {
  expenseName: { type: 'string', maxLength: 160 },
  expenseDate: { type: 'string', format: 'date' },
  amountPaise: { type: 'integer', minimum: 1 },
  category: { type: 'string', maxLength: 60 },
  paymentReceiver: { type: 'string', maxLength: 160 },
  invoiceNumber: { type: 'string', maxLength: 80 },
  isTaxPaid: { type: 'boolean' },
  paymentMode: { type: 'string', enum: ['CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'OTHER'] },
  cashShiftId: { type: 'string', format: 'uuid' },
  notes: { type: 'string', maxLength: 1000 },
  attachmentUrl: { type: 'string', maxLength: 1000 },
}

export const createExpenseSchema = {
  tags: ['Vendor Expenses'],
  summary: 'Record a shop-floor expense [VENDOR]',
  body: { type: 'object', required: ['expenseName', 'expenseDate', 'amountPaise'], properties: expenseBodyProperties },
  response: { 201: envelope({ type: 'object', properties: expenseProperties }) },
}

export const updateExpenseSchema = {
  tags: ['Vendor Expenses'],
  summary: 'Edit an existing expense (requires a reason) [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['expenseName', 'expenseDate', 'amountPaise', 'reason'], properties: { ...expenseBodyProperties, reason: { type: 'string', maxLength: 500 } } },
  response: { 200: envelope({ type: 'object', properties: expenseProperties }) },
}

export const cancelExpenseSchema = {
  tags: ['Vendor Expenses'],
  summary: 'Cancel a paid expense (requires a reason) [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } },
  response: { 200: envelope({ type: 'object', properties: expenseProperties }) },
}

export const listExpensesSchema = {
  tags: ['Vendor Expenses'],
  summary: 'List this vendor\'s expenses [VENDOR]',
  querystring: {
    type: 'object',
    properties: {
      search: { type: 'string' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' },
      page: { type: 'integer' }, limit: { type: 'integer' },
    },
  },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: expenseProperties } }) },
}
