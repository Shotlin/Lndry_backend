// NOTE: this Fastify instance runs Ajv with `removeAdditional: 'all'`, so every
// field a body/response should keep is listed explicitly below.

const settingsProps = {
  enabled: { type: 'boolean' },
  scope: { type: 'string', enum: ['ALL', 'SELECTED'] },
  title: { type: 'string' },
  subtitle: { type: 'string' },
  buttonText: { type: 'string' },
  iconUrl: { type: ['string', 'null'] },
  checkoutNote: { type: 'string' },
  assessmentTitle: { type: 'string' },
  assessmentMessage: { type: 'string' },
  priceLabel: { type: 'string' },
}

const adminViewSchema = {
  type: 'object',
  properties: {
    ...settingsProps,
    updatedAt: { type: ['string', 'null'] },
    selectedVendors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
      },
    },
  },
}

const envelope = (data) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data },
})

export const getAssistedBookingSchema = {
  tags: ['Admin'],
  summary: 'Assisted booking (Book With Expert Check) settings',
  response: { 200: envelope(adminViewSchema) },
}

export const updateAssistedBookingSchema = {
  tags: ['Admin'],
  summary: 'Update assisted booking settings and selected vendors',
  body: {
    type: 'object',
    properties: {
      ...settingsProps,
      vendorIds: { type: 'array', maxItems: 2000, items: { type: 'string', format: 'uuid' } },
    },
  },
  response: { 200: envelope(adminViewSchema) },
}

export const publicAssistedBookingSchema = {
  tags: ['Customer Profile'],
  summary: 'Is "Book With Expert Check" offered for this vendor? (public)',
  querystring: {
    type: 'object',
    properties: { vendor_id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        available: { type: 'boolean' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        buttonText: { type: 'string' },
        iconUrl: { type: ['string', 'null'] },
        checkoutNote: { type: 'string' },
        assessmentTitle: { type: 'string' },
        assessmentMessage: { type: 'string' },
        priceLabel: { type: 'string' },
      },
    }),
  },
}
