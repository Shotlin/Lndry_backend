const query = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    channel: { type: 'string', enum: ['ALL', 'POS', 'ONLINE'], default: 'ALL' },
  },
}

// No response schema on purpose: the report is a large, nested, evolving object and this app's
// serializer drops any field a schema does not list.
export const financeOverviewSchema = {
  tags: ['Vendor Finance'],
  summary: 'Finance overview for a date range, by channel (All / POS / LNDRY online) [VENDOR OWNER]',
  querystring: query,
}

export const financeStatutorySchema = {
  tags: ['Vendor Finance'],
  summary: 'GST / statutory report for a date range, by channel [VENDOR OWNER]',
  querystring: query,
}
