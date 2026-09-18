const viewProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  ownerId: { type: 'string' },
  viewName: { type: 'string' },
  reportKind: { type: 'string' },
  fromDate: { type: ['string', 'null'] },
  toDate: { type: ['string', 'null'] },
  search: { type: ['string', 'null'] },
  shared: { type: 'boolean' },
  active: { type: 'boolean' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const listReportViewsSchema = {
  tags: ['Vendor Report Views'],
  summary: 'Saved report-filter presets visible to this staff member [VENDOR]',
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: viewProperties } }) },
}

export const createReportViewSchema = {
  tags: ['Vendor Report Views'],
  summary: 'Save a report filter preset [VENDOR]',
  body: {
    type: 'object',
    required: ['viewName', 'reportKind'],
    properties: {
      viewName: { type: 'string', maxLength: 120 },
      reportKind: { type: 'string', maxLength: 60 },
      fromDate: { type: 'string', format: 'date' },
      toDate: { type: 'string', format: 'date' },
      search: { type: 'string', maxLength: 120 },
      shared: { type: 'boolean' },
    },
  },
  response: { 201: envelope({ type: 'object', properties: viewProperties }) },
}

export const deleteReportViewSchema = {
  tags: ['Vendor Report Views'],
  summary: 'Delete a saved report view (owner only) [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'object', properties: viewProperties }) },
}
