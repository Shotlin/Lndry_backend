const holdProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  holdCode: { type: 'string' },
  status: { type: 'string' },
  payload: { type: 'object', additionalProperties: true },
  ownerUserId: { type: ['string', 'null'] },
  ownershipUpdatedAt: { type: ['string', 'null'] },
  leaseExpiresAt: { type: ['string', 'null'] },
  ownership: { type: 'string' },
  resumedBy: { type: ['string', 'null'] },
  resumedAt: { type: ['string', 'null'] },
  cancelledBy: { type: ['string', 'null'] },
  cancelledAt: { type: ['string', 'null'] },
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const createOrderHoldSchema = {
  tags: ['Vendor Order Holds'],
  summary: 'Park an in-progress counter-sale cart for later [VENDOR]',
  // The cart payload is free-form. `additionalProperties: true` alone would NOT
  // keep its keys — this instance runs Ajv with `removeAdditional: 'all'`, which
  // emptied `payload` to `{}` so every hold failed the "needs a cart line"
  // check. `patternProperties` (empty schema = accept as-is) keeps every key
  // and leaves nested values untouched.
  body: {
    type: 'object',
    required: ['payload'],
    properties: {
      payload: {
        type: 'object',
        additionalProperties: false,
        patternProperties: { '^[\\s\\S]*$': {} },
      },
    },
  },
  response: { 201: envelope({ type: 'object', properties: holdProperties }) },
}

export const listOrderHoldsSchema = {
  tags: ['Vendor Order Holds'],
  summary: 'List parked counter-sale carts [VENDOR]',
  querystring: { type: 'object', properties: { includeClosed: { type: 'string' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: holdProperties } }) },
}

export const orderHoldPresenceSchema = {
  tags: ['Vendor Order Holds'],
  summary: 'Live counter-presence summary of held carts [VENDOR]',
  response: {
    200: envelope({
      type: 'object',
      properties: {
        observedAt: { type: 'string' }, leaseMinutes: { type: 'integer' }, totalHeld: { type: 'integer' },
        mineActive: { type: 'integer' }, otherActive: { type: 'integer' }, expired: { type: 'integer' },
        unassigned: { type: 'integer' }, staleHoldCodes: { type: 'array', items: { type: 'string' } },
      },
    }),
  },
}

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }
const overrideBody = { type: 'object', properties: { override: { type: 'boolean' } } }

export const claimOrderHoldSchema = { tags: ['Vendor Order Holds'], summary: 'Claim ownership of a held cart [VENDOR]', params: idParams, response: { 200: envelope({ type: 'object', properties: holdProperties }) } }
export const renewOrderHoldSchema = { tags: ['Vendor Order Holds'], summary: "Renew this counter's lease on a held cart [VENDOR]", params: idParams, response: { 200: envelope({ type: 'object', properties: holdProperties }) } }
export const releaseOrderHoldSchema = { tags: ['Vendor Order Holds'], summary: 'Release ownership of a held cart [VENDOR]', params: idParams, body: overrideBody, response: { 200: envelope({ type: 'object', properties: holdProperties }) } }
export const resumeOrderHoldSchema = { tags: ['Vendor Order Holds'], summary: 'Resume a held cart to continue booking it [VENDOR]', params: idParams, body: overrideBody, response: { 200: envelope({ type: 'object', properties: holdProperties }) } }
export const cancelOrderHoldSchema = { tags: ['Vendor Order Holds'], summary: 'Cancel a held cart [VENDOR]', params: idParams, body: overrideBody, response: { 200: envelope({ type: 'object', properties: holdProperties }) } }
