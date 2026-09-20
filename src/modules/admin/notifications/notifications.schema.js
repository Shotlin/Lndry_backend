// The app's Ajv config strips undeclared properties, so nested objects must
// list every key they may carry.
const linkParams = {
  type: 'object',
  properties: {
    orderId: { type: 'string', maxLength: 64 },
    vendorId: { type: 'string', maxLength: 64 },
    route: { type: 'string', maxLength: 200 },
  },
}
const linkSpec = {
  type: 'object',
  nullable: true,
  properties: { type: { type: 'string', maxLength: 40 }, params: linkParams },
}
const audienceSpec = {
  type: 'object',
  properties: {
    kind: { type: 'string', maxLength: 30 },
    userId: { type: 'string', maxLength: 64 },
    vendorId: { type: 'string', maxLength: 64 },
    segmentId: { type: 'string', maxLength: 64 },
    target: { type: 'string', maxLength: 20 },
    city: { type: 'string', maxLength: 100 },
    pincode: { type: 'string', maxLength: 12 },
    segment: { type: 'string', maxLength: 40 },
    value: { type: 'string', maxLength: 100 },
  },
}

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const templateIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const createTemplateSchema = {
  body: {
    type: 'object',
    required: ['name', 'title', 'body'],
    properties: {
      name:      { type: 'string', minLength: 1, maxLength: 100 },
      title:     { type: 'string', minLength: 1, maxLength: 200 },
      body:      { type: 'string', minLength: 1, maxLength: 2000 },
      type:      { type: 'string', enum: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'], default: 'PUSH' },
      variables: { type: 'array', items: { type: 'string' } },
      image_url: { type: 'string', maxLength: 2000 },
      deep_link: { type: 'string', maxLength: 500 },
      deep_link_type: { type: 'string', maxLength: 40 },
      deep_link_params: linkParams,
    },
  },
}

export const updateTemplateSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    properties: {
      name:      { type: 'string', minLength: 1, maxLength: 100 },
      title:     { type: 'string', minLength: 1, maxLength: 200 },
      body:      { type: 'string', minLength: 1, maxLength: 2000 },
      type:      { type: 'string', enum: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'] },
      variables: { type: 'array', items: { type: 'string' } },
      image_url: { type: 'string', maxLength: 2000 },
      deep_link: { type: 'string', maxLength: 500 },
      deep_link_type: { type: 'string', maxLength: 40, nullable: true },
      deep_link_params: linkParams,
      is_active: { type: 'boolean' },
    },
  },
}

const VALID_SEGMENTS = ['all_customers', 'specific_user', 'store_customers', 'inactive_customers', 'cart_not_empty', 'all', 'new', 'inactive', 'high_value']

export const sendBulkSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'segment'],
    properties: {
      title:          { type: 'string', minLength: 1, maxLength: 200 },
      body:           { type: 'string', minLength: 1, maxLength: 2000 },
      segment:        { type: 'string', enum: VALID_SEGMENTS },
      segmentValue:   { type: 'string' },
      segmentFilters: { type: 'object' },
      image_url:      { type: 'string', maxLength: 2000 },
      deep_link:      { type: 'string', maxLength: 500 },
      type:           { type: 'string', enum: ['system', 'offer', 'product_offer', 'category_offer', 'store_offer', 'order_update', 'rider_update', 'wallet', 'coupon', 'cart_reminder', 'general'], default: 'general' },
      expires_at:     { type: 'string', format: 'date-time' },
      template_id:    { type: 'string', pattern: uuidPattern },
      target_phones:  { type: 'array', items: { type: 'string' } },
    },
  },
}

export const scheduleCampaignSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'segment', 'scheduledAt'],
    properties: {
      title:          { type: 'string', minLength: 1, maxLength: 200 },
      body:           { type: 'string', minLength: 1, maxLength: 2000 },
      segment:        { type: 'string', enum: VALID_SEGMENTS },
      segmentValue:   { type: 'string' },
      segmentFilters: { type: 'object' },
      scheduledAt:    { type: 'string', format: 'date-time' },
      image_url:      { type: 'string', maxLength: 2000 },
      deep_link:      { type: 'string', maxLength: 500 },
      type:           { type: 'string', enum: ['system', 'offer', 'product_offer', 'category_offer', 'store_offer', 'order_update', 'rider_update', 'wallet', 'coupon', 'cart_reminder', 'general'], default: 'general' },
      expires_at:     { type: 'string', format: 'date-time' },
      template_id:    { type: 'string', pattern: uuidPattern },
    },
  },
}

export const listCampaignsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page:   { type: 'integer', minimum: 1, default: 1 },
      limit:  { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      status: { type: 'string' },
    },
  },
}

export const campaignIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const cancelCampaignSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const segmentCountSchema = {
  querystring: {
    type: 'object',
    required: ['segment'],
    properties: {
      segment:       { type: 'string', enum: VALID_SEGMENTS },
      segmentValue:  { type: 'string' },
    },
  },
}

/* ── Notification Center (campaigns v2) ─────────────────────────────────── */

const campaignFields = {
  title:       { type: 'string', maxLength: 200 },
  body:        { type: 'string', maxLength: 2000 },
  image_url:   { type: 'string', maxLength: 2000 },
  link:        linkSpec,
  audience:    audienceSpec,
  type:        { type: 'string', maxLength: 40 },
  expires_at:  { type: 'string', format: 'date-time' },
  template_id: { type: 'string', pattern: uuidPattern },
}

export const createCampaignSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'audience'],
    properties: {
      ...campaignFields,
      mode:        { type: 'string', enum: ['SEND_NOW', 'SCHEDULE', 'DRAFT'], default: 'SEND_NOW' },
      scheduledAt: { type: 'string', format: 'date-time' },
    },
  },
}

export const updateDraftSchema = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } },
  body: { type: 'object', properties: campaignFields },
}

export const sendDraftSchema = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } },
  body: {
    type: 'object',
    properties: {
      mode:        { type: 'string', enum: ['SEND_NOW', 'SCHEDULE'], default: 'SEND_NOW' },
      scheduledAt: { type: 'string', format: 'date-time' },
    },
  },
}

export const audienceCountBodySchema = {
  body: { type: 'object', required: ['audience'], properties: { audience: audienceSpec } },
}

export const recipientSearchSchema = {
  querystring: {
    type: 'object',
    properties: {
      q:    { type: 'string', maxLength: 100, default: '' },
      type: { type: 'string', enum: ['customer', 'vendor', 'captain', 'any'], default: 'any' },
    },
  },
}

export const testSendSchema = {
  body: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId:    { type: 'string', pattern: uuidPattern },
      title:     { type: 'string', maxLength: 200 },
      body:      { type: 'string', maxLength: 2000 },
      image_url: { type: 'string', maxLength: 2000 },
      link:      linkSpec,
    },
  },
}
