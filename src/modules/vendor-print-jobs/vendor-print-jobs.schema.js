const jobProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  orderId: { type: 'string' },
  documentType: { type: 'string' },
  garmentUnitIds: { type: 'array', items: { type: 'string' } },
  containerIds: { type: 'array', items: { type: 'string' } },
  printerProfile: { type: ['string', 'null'] },
  requestedCopies: { type: 'integer' },
  status: { type: 'string' },
  failureReason: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const createPrintJobSchema = {
  tags: ['Vendor Print Jobs'],
  summary: 'Log a tag/label print request [VENDOR]',
  body: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
      documentType: { type: 'string', enum: ['GARMENT_TAG', 'CONTAINER_TAG', 'RECEIPT'] },
      garmentUnitIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      containerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      printerProfile: { type: 'string', maxLength: 80 },
      requestedCopies: { type: 'integer', minimum: 1, maximum: 20 },
    },
  },
  response: { 201: envelope({ type: 'object', properties: jobProperties }) },
}

export const updatePrintJobStatusSchema = {
  tags: ['Vendor Print Jobs'],
  summary: 'Mark a print job printed or failed [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['PENDING', 'PRINTED', 'FAILED'] }, failureReason: { type: 'string', maxLength: 500 } } },
  response: { 200: envelope({ type: 'object', properties: jobProperties }) },
}

export const listPrintJobsForOrderSchema = {
  tags: ['Vendor Print Jobs'],
  summary: 'List print jobs for an order [VENDOR]',
  params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: jobProperties } }) },
}
