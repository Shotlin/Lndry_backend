const correctionProperties = {
  id: { type: 'string' },
  claimId: { type: 'string' },
  customerUserId: { type: 'string' },
  orderId: { type: 'string' },
  garmentUnitId: { type: 'string' },
  decision: { type: 'string' },
  summary: { type: 'string' },
  customerMessage: { type: 'string' },
  issuedAt: { type: 'string' },
  issuedBy: { type: 'string' },
}

const claimProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  garmentUnitId: { type: 'string' },
  orderId: { type: 'string' },
  category: { type: 'string' },
  severity: { type: 'string' },
  status: { type: 'string' },
  description: { type: 'string' },
  openedAt: { type: 'string' },
  openedBy: { type: 'string' },
  decision: { type: ['string', 'null'] },
  resolutionNote: { type: ['string', 'null'] },
  resolvedAt: { type: ['string', 'null'] },
  resolvedBy: { type: ['string', 'null'] },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const claimDetailProperties = { ...claimProperties, correction: { type: ['object', 'null'], properties: correctionProperties } }

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const openQualityClaimSchema = {
  tags: ['Vendor Quality Claims'],
  summary: 'Open a quality claim on a garment [VENDOR]',
  body: {
    type: 'object',
    required: ['garmentUnitId', 'category', 'description'],
    properties: {
      garmentUnitId: { type: 'string', format: 'uuid' },
      category: { type: 'string', enum: ['STAIN', 'DAMAGE', 'MISSING', 'REWASH', 'OTHER'] },
      severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      description: { type: 'string', maxLength: 1000 },
    },
  },
  response: { 201: envelope({ type: 'object', properties: claimProperties }) },
}

export const resolveQualityClaimSchema = {
  tags: ['Vendor Quality Claims'],
  summary: 'Resolve a quality claim with a decision [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: {
    type: 'object',
    required: ['decision', 'note'],
    properties: { decision: { type: 'string', enum: ['REWASH', 'DAMAGED', 'MISSING', 'RELEASE', 'REJECT'] }, note: { type: 'string', maxLength: 1000 } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: { claim: { type: 'object', properties: claimProperties }, correction: { type: ['object', 'null'], properties: correctionProperties } },
    }),
  },
}

export const listQualityClaimsSchema = {
  tags: ['Vendor Quality Claims'],
  summary: "This vendor's quality claims [VENDOR]",
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'] },
      garmentUnitId: { type: 'string', format: 'uuid' }, page: { type: 'integer' }, limit: { type: 'integer' },
    },
  },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: claimProperties } }) },
}

export const getQualityClaimSchema = {
  tags: ['Vendor Quality Claims'],
  summary: 'Quality claim detail with its customer correction, if any [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  response: { 200: envelope({ type: 'object', properties: claimDetailProperties }) },
}
