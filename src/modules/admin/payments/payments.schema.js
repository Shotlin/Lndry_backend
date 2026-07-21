export const listPaymentsSchema = {
  tags: ['Admin Payments'],
  summary: 'List payment transactions with customer/order context',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string', enum: ['PENDING', 'PAID', 'FAILED', 'REFUNDED'] },
      search: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}
