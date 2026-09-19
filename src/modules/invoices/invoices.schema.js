/**
 * Invoices JSON Schemas.
 * Every response field must be listed — undeclared ones are dropped by the
 * serializer (this app also runs Ajv with removeAdditional: 'all').
 */

const orderParams = {
  type: 'object',
  required: ['orderId'],
  properties: { orderId: { type: 'string', format: 'uuid' } },
}

const invoiceInfo = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    invoiceNumber: { type: 'string' },
    orderId: { type: 'string' },
    orderNumber: { type: ['string', 'null'] },
    orderType: { type: 'string' },
    status: { type: 'string' },
    issuedAt: { type: 'string' },
    invoiceDate: { type: 'string' },
    currency: { type: 'string' },
    subtotalPaise: { type: 'integer' },
    discountPaise: { type: 'integer' },
    deliveryFeePaise: { type: 'integer' },
    platformFeePaise: { type: 'integer' },
    taxPaise: { type: 'integer' },
    totalPaise: { type: 'integer' },
    amountPaidPaise: { type: 'integer' },
    balanceDuePaise: { type: 'integer' },
    paymentStatus: { type: 'string' },
    paymentMethod: { type: ['string', 'null'] },
    templateId: { type: 'string' },
    pdf: {
      type: 'object',
      properties: {
        contentType: { type: 'string' },
        sizeBytes: { type: ['integer', 'null'] },
        generatedAt: { type: ['string', 'null'] },
      },
    },
    viewUrl: { type: 'string' },
    downloadUrl: { type: 'string' },
    linksExpireAt: { type: 'string' },
  },
}

const envelope = (data) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data,
  },
})

export const getInvoiceSchema = {
  tags: ['Invoices'],
  summary: 'Invoice info for one of my orders (issued on first request if the order is delivered)',
  security: [{ bearerAuth: [] }],
  params: orderParams,
  response: { 200: envelope(invoiceInfo) },
}

export const generateInvoiceSchema = {
  tags: ['Invoices'],
  summary: 'Issue the invoice for one of my delivered orders (idempotent)',
  security: [{ bearerAuth: [] }],
  params: orderParams,
  response: { 200: envelope(invoiceInfo), 201: envelope(invoiceInfo) },
}

export const invoicePdfSchema = {
  tags: ['Invoices'],
  summary: 'Invoice PDF for one of my orders',
  security: [{ bearerAuth: [] }],
  params: orderParams,
  querystring: {
    type: 'object',
    properties: { download: { type: 'boolean', default: false } },
  },
}

export const downloadInvoiceSchema = {
  tags: ['Invoices'],
  summary: 'Invoice PDF via a short-lived signed link',
  querystring: {
    type: 'object',
    required: ['t'],
    properties: { t: { type: 'string', minLength: 20, maxLength: 2000 } },
  },
}

export const regenerateInvoicesSchema = {
  tags: ['Invoices', 'Admin'],
  summary: 'Re-render stored invoices with the currently active template [ADMIN]',
  body: {
    type: 'object',
    properties: {
      orderId: { type: 'string', format: 'uuid' },
      rebuild: { type: 'boolean', default: false },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        regenerated: { type: 'integer' },
        skipped: { type: 'integer' },
        template: { type: 'string' },
        failed: {
          type: 'array',
          items: {
            type: 'object',
            properties: { orderId: { type: 'string' }, error: { type: 'string' } },
          },
        },
      },
    }),
  },
}
