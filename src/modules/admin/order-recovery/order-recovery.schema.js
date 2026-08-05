/**
 * Order Recovery JSON Schemas
 */

const draftListItemProperties = {
  id:                { type: 'string' },
  userId:            { type: 'string' },
  userName:          { type: ['string', 'null'] },
  userPhone:         { type: ['string', 'null'] },
  vendorId:          { type: 'string' },
  vendorName:        { type: ['string', 'null'] },
  payableAmountPaise:{ type: 'integer' },
  createdAt:         { type: 'string' },
  paymentId:         { type: ['string', 'null'] },
  paymentStatus:     { type: ['string', 'null'] },
  paymentExpiresAt:  { type: ['string', 'null'] },
  reminderCount:     { type: 'integer' },
  lastReminderSentAt:{ type: ['string', 'null'] },
}

export const listIncompleteOrdersSchema = {
  tags: ['Order Recovery'],
  summary: 'Incomplete (never-completed) checkouts [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      page:   { type: 'integer', minimum: 1, default: 1 },
      limit:  { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      search: { type: 'string', maxLength: 100 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: draftListItemProperties } },
        pagination: { type: 'object' },
      },
    },
  },
}

export const incompleteOrdersSummarySchema = {
  tags: ['Order Recovery'],
  summary: 'Incomplete-checkout summary stats [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            incompleteCount:      { type: 'integer' },
            incompleteValuePaise: { type: 'integer' },
            recoveredToday:       { type: 'integer' },
          },
        },
      },
    },
  },
}

export const getIncompleteOrderSchema = {
  tags: ['Order Recovery'],
  summary: 'Incomplete checkout detail [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const sendRecoveryReminderSchema = {
  tags: ['Order Recovery'],
  summary: 'Send a recovery reminder notification [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['title', 'body'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      body:  { type: 'string', minLength: 1, maxLength: 300 },
    },
  },
}

export const issueRecoveryCouponSchema = {
  tags: ['Order Recovery'],
  summary: 'Issue (create or assign) a coupon to nudge checkout completion [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      couponId:       { type: 'string', format: 'uuid' },
      code:           { type: 'string', minLength: 2, maxLength: 50 },
      description:    { type: 'string', maxLength: 500 },
      discountType:   { type: 'string', enum: ['PERCENTAGE', 'FLAT'] },
      discountValue:  { type: 'number', minimum: 0.01 },
      minOrderAmount: { type: 'number', minimum: 0 },
      maxDiscount:    { type: 'number', minimum: 0 },
      validUntil:     { type: 'string', format: 'date-time' },
    },
  },
}
