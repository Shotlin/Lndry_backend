const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const posDashboardSchema = {
  tags: ['Vendor POS Dashboard'],
  summary: 'Counter/POS operations dashboard — sales, cash, tasks, claims, holds [VENDOR]',
  response: {
    200: envelope({
      type: 'object',
      properties: {
        asOf: { type: 'string' },
        counterSalesToday: { type: 'object', properties: { count: { type: 'integer' }, revenuePaise: { type: 'integer' } } },
        cashShift: { type: ['object', 'null'], properties: { id: { type: 'string' }, register: { type: 'string' }, openingCashPaise: { type: 'integer' }, openedAt: { type: 'string' } } },
        productionTasks: { type: 'object', properties: { open: { type: 'integer' }, inProgress: { type: 'integer' }, urgent: { type: 'integer' } } },
        openQualityClaims: { type: 'integer' },
        pendingReturnCases: { type: 'integer' },
        pendingRiderSettlements: { type: 'integer' },
        activeOrderHolds: { type: 'integer' },
        topGarmentsLast7Days: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, units: { type: 'integer' }, revenuePaise: { type: 'integer' } } } },
      },
    }),
  },
}

export const exportCounterSalesCsvSchema = {
  tags: ['Vendor POS Dashboard'],
  summary: 'Export counter sales in a date range as CSV [VENDOR]',
  querystring: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } },
}

export const posSearchSchema = {
  tags: ['Vendor POS Dashboard'],
  summary: 'Search customers, counter sales, and garment tags by keyword [VENDOR]',
  querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2, maxLength: 120 } } },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        customers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' } } } },
        orders: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, orderNumber: { type: ['string', 'null'] }, totalPaise: { type: 'integer' }, placedAt: { type: 'string' } } } },
        garmentUnits: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tagCode: { type: 'string' }, state: { type: 'string' }, orderId: { type: 'string' } } } },
      },
    }),
  },
}
