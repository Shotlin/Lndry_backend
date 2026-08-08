/**
 * First-Time Offers JSON Schemas
 */

const offerProperties = {
  id:              { type: 'string' },
  name:            { type: 'string' },
  minOrderAmount:  { type: 'number' },
  rewardType:      { type: 'string' },
  rewardValue:     { type: ['number', 'null'] },
  maxDiscount:     { type: ['number', 'null'] },
  unlockCouponId:  { type: ['string', 'null'] },
  startAt:         { type: ['string', 'null'] },
  endAt:           { type: ['string', 'null'] },
  isActive:        { type: 'boolean' },
  autoApply:       { type: 'boolean' },
  createdBy:       { type: ['string', 'null'] },
  createdAt:       { type: 'string' },
  updatedAt:       { type: 'string' },
}

const offerResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: offerProperties },
  },
}

export const listFirstTimeOffersSchema = {
  tags: ['First-Time Offers'],
  summary: 'All first-time offers [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: offerProperties } },
      },
    },
  },
}

export const activeFirstTimeOffersSchema = {
  tags: ['First-Time Offers'],
  summary: 'Active first-time offer tiers for the current customer',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            eligible: { type: 'boolean' },
            tiers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  minOrderAmount: { type: 'number' },
                  rewardType: { type: 'string' },
                  rewardValue: { type: ['number', 'null'] },
                  maxDiscount: { type: ['number', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  },
}

export const createFirstTimeOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Create first-time offer [ADMIN]',
  body: {
    type: 'object',
    required: ['name', 'rewardType'],
    properties: {
      name:            { type: 'string', minLength: 2, maxLength: 100 },
      minOrderAmount:  { type: 'number', minimum: 0, default: 0 },
      rewardType:      { type: 'string', enum: ['FREE_DELIVERY', 'FLAT_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'COUPON_UNLOCK'] },
      rewardValue:     { type: 'number', minimum: 0 },
      maxDiscount:     { type: 'number', minimum: 0 },
      unlockCouponId:  { type: 'string', format: 'uuid' },
      startAt:         { type: 'string', format: 'date-time' },
      endAt:           { type: 'string', format: 'date-time' },
      autoApply:       { type: 'boolean', default: true },
    },
  },
  response: { 201: offerResponse },
}

export const updateFirstTimeOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Update first-time offer [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:            { type: 'string', minLength: 2, maxLength: 100 },
      minOrderAmount:  { type: 'number', minimum: 0 },
      rewardType:      { type: 'string', enum: ['FREE_DELIVERY', 'FLAT_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'COUPON_UNLOCK'] },
      rewardValue:     { type: 'number', minimum: 0 },
      maxDiscount:     { type: 'number', minimum: 0 },
      unlockCouponId:  { type: ['string', 'null'], format: 'uuid' },
      startAt:         { type: ['string', 'null'], format: 'date-time' },
      endAt:           { type: ['string', 'null'], format: 'date-time' },
      isActive:        { type: 'boolean' },
      autoApply:       { type: 'boolean' },
    },
  },
  response: { 200: offerResponse },
}

export const deleteFirstTimeOfferSchema = {
  tags: ['First-Time Offers'],
  summary: 'Delete first-time offer [ADMIN]',
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
