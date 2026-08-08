/**
 * Cart Milestones JSON Schemas
 */

const milestoneProperties = {
  id:                    { type: 'string' },
  name:                  { type: 'string' },
  minOrderAmount:        { type: 'number' },
  rewardType:            { type: 'string' },
  rewardValue:           { type: ['number', 'null'] },
  maxDiscount:           { type: ['number', 'null'] },
  unlockCouponId:        { type: ['string', 'null'] },
  messageBefore:         { type: ['string', 'null'] },
  messageAfter:          { type: ['string', 'null'] },
  isActive:              { type: 'boolean' },
  applicableUserType:    { type: 'string' },
  applicableSegmentId:   { type: ['string', 'null'] },
  stackableWithCoupon:   { type: 'boolean' },
  usageLimitPerUser:     { type: ['integer', 'null'] },
  priority:              { type: 'integer' },
  createdBy:             { type: ['string', 'null'] },
  createdAt:             { type: 'string' },
  updatedAt:             { type: 'string' },
}

const milestoneResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: milestoneProperties },
  },
}

export const listCartMilestonesSchema = {
  tags: ['Cart Milestones'],
  summary: 'All cart milestones [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: milestoneProperties } },
      },
    },
  },
}

export const createCartMilestoneSchema = {
  tags: ['Cart Milestones'],
  summary: 'Create cart milestone [ADMIN]',
  body: {
    type: 'object',
    required: ['name', 'rewardType', 'minOrderAmount'],
    properties: {
      name:                 { type: 'string', minLength: 2, maxLength: 100 },
      minOrderAmount:       { type: 'number', minimum: 0 },
      rewardType:           { type: 'string', enum: ['FLAT_DISCOUNT', 'COUPON_UNLOCK'] },
      rewardValue:          { type: 'number', minimum: 0 },
      maxDiscount:          { type: 'number', minimum: 0 },
      unlockCouponId:       { type: 'string', format: 'uuid' },
      messageBefore:        { type: 'string' },
      messageAfter:         { type: 'string' },
      applicableUserType:   { type: 'string', enum: ['ALL', 'FIRST_TIME', 'SEGMENT'], default: 'ALL' },
      applicableSegmentId:  { type: 'string', format: 'uuid' },
      stackableWithCoupon:  { type: 'boolean', default: true },
      usageLimitPerUser:    { type: 'integer', minimum: 1 },
      priority:             { type: 'integer', default: 0 },
    },
  },
  response: { 201: milestoneResponse },
}

export const updateCartMilestoneSchema = {
  tags: ['Cart Milestones'],
  summary: 'Update cart milestone [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:                 { type: 'string', minLength: 2, maxLength: 100 },
      minOrderAmount:       { type: 'number', minimum: 0 },
      rewardType:           { type: 'string', enum: ['FLAT_DISCOUNT', 'COUPON_UNLOCK'] },
      rewardValue:          { type: 'number', minimum: 0 },
      maxDiscount:          { type: 'number', minimum: 0 },
      unlockCouponId:       { type: ['string', 'null'], format: 'uuid' },
      messageBefore:        { type: ['string', 'null'] },
      messageAfter:         { type: ['string', 'null'] },
      isActive:             { type: 'boolean' },
      applicableUserType:   { type: 'string', enum: ['ALL', 'FIRST_TIME', 'SEGMENT'] },
      applicableSegmentId:  { type: ['string', 'null'], format: 'uuid' },
      stackableWithCoupon:  { type: 'boolean' },
      usageLimitPerUser:    { type: ['integer', 'null'], minimum: 1 },
      priority:             { type: 'integer' },
    },
  },
  response: { 200: milestoneResponse },
}

export const deleteCartMilestoneSchema = {
  tags: ['Cart Milestones'],
  summary: 'Delete cart milestone [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data:    { type: 'null' },
      },
    },
  },
}
