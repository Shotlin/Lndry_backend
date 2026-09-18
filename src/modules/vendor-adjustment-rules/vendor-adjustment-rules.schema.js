const ruleProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  kind: { type: 'string' },
  name: { type: 'string' },
  type: { type: 'string' },
  flatAmountPaise: { type: ['integer', 'null'] },
  percentageBps: { type: ['integer', 'null'] },
  description: { type: ['string', 'null'] },
  active: { type: 'boolean' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

const kindParam = { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['charge', 'discount'] } } }

export const listAdjustmentRulesSchema = {
  tags: ['Vendor Adjustment Rules'],
  summary: 'List this vendor\'s charge or discount rules [VENDOR]',
  params: kindParam,
  querystring: { type: 'object', properties: { includeInactive: { type: 'string' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: ruleProperties } }) },
}

const ruleBodyProperties = {
  name: { type: 'string', maxLength: 160 },
  type: { type: 'string', enum: ['FLAT', 'PERCENTAGE'] },
  flatAmountPaise: { type: 'integer', minimum: 0 },
  percentageBps: { type: 'integer', minimum: 0, maximum: 10000 },
  description: { type: 'string', maxLength: 500 },
  active: { type: 'boolean' },
}

export const createAdjustmentRuleSchema = {
  tags: ['Vendor Adjustment Rules'],
  summary: 'Create a charge or discount rule [VENDOR]',
  params: kindParam,
  body: { type: 'object', required: ['name', 'type'], properties: ruleBodyProperties },
  response: { 201: envelope({ type: 'object', properties: ruleProperties }) },
}

export const updateAdjustmentRuleSchema = {
  tags: ['Vendor Adjustment Rules'],
  summary: 'Update a charge or discount rule [VENDOR]',
  params: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['charge', 'discount'] }, id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', required: ['name', 'type'], properties: ruleBodyProperties },
  response: { 200: envelope({ type: 'object', properties: ruleProperties }) },
}
