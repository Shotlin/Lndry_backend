const entryProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  customerUserId: { type: ['string', 'null'] },
  customerName: { type: ['string', 'null'] },
  customerPhone: { type: ['string', 'null'] },
  entryType: { type: 'string' },
  debitPaise: { type: 'integer' },
  creditPaise: { type: 'integer' },
  referenceType: { type: ['string', 'null'] },
  referenceId: { type: ['string', 'null'] },
  reason: { type: ['string', 'null'] },
  entryDate: { type: 'string' },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const appendLedgerEntrySchema = {
  tags: ['Vendor Customer Ledger'],
  summary: "Record an entry on a customer's account ledger [VENDOR]",
  body: {
    type: 'object',
    required: ['entryType'],
    properties: {
      customerUserId: { type: 'string', format: 'uuid' },
      customerName: { type: 'string', maxLength: 160 },
      customerPhone: { type: 'string', maxLength: 15 },
      entryType: { type: 'string' },
      debitPaise: { type: 'integer', minimum: 0 },
      creditPaise: { type: 'integer', minimum: 0 },
      referenceType: { type: 'string', maxLength: 40 },
      referenceId: { type: 'string', format: 'uuid' },
      reason: { type: 'string', maxLength: 500 },
      entryDate: { type: 'string', format: 'date' },
    },
  },
  response: { 201: envelope({ type: 'object', properties: entryProperties }) },
}

export const getLedgerStatementSchema = {
  tags: ['Vendor Customer Ledger'],
  summary: "A customer's running ledger balance and entry history [VENDOR]",
  querystring: {
    type: 'object',
    properties: { customerUserId: { type: 'string', format: 'uuid' }, phone: { type: 'string' } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        balancePaise: { type: 'integer' },
        entries: { type: 'array', items: { type: 'object', properties: entryProperties } },
      },
    }),
  },
}
