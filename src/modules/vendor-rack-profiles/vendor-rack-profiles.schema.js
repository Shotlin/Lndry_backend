const profileProperties = {
  id: { type: 'string' },
  vendorId: { type: 'string' },
  name: { type: 'string' },
  code: { type: ['string', 'null'] },
  capacity: { type: 'integer' },
  active: { type: 'boolean' },
  notes: { type: ['string', 'null'] },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const envelope = (dataSchema) => ({
  type: 'object',
  properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: dataSchema },
})

export const listRackProfilesSchema = {
  tags: ['Vendor Rack Profiles'],
  summary: "This vendor's storage rack profiles [VENDOR]",
  querystring: { type: 'object', properties: { includeInactive: { type: 'string' } } },
  response: { 200: envelope({ type: 'array', items: { type: 'object', properties: profileProperties } }) },
}

const rackBodyProperties = {
  name: { type: 'string', maxLength: 120 },
  code: { type: 'string', maxLength: 40 },
  capacity: { type: 'integer', minimum: 1, maximum: 100000 },
  active: { type: 'boolean' },
  notes: { type: 'string', maxLength: 500 },
}

export const createRackProfileSchema = {
  tags: ['Vendor Rack Profiles'],
  summary: 'Create a storage rack profile [VENDOR]',
  body: { type: 'object', required: ['name', 'capacity'], properties: rackBodyProperties },
  response: { 201: envelope({ type: 'object', properties: profileProperties }) },
}

export const updateRackProfileSchema = {
  tags: ['Vendor Rack Profiles'],
  summary: 'Update a storage rack profile [VENDOR]',
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
  body: { type: 'object', properties: rackBodyProperties },
  response: { 200: envelope({ type: 'object', properties: profileProperties }) },
}
