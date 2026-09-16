/**
 * Referral Programs JSON Schemas
 */

const REWARD_TYPE_ENUM = ['WALLET_CREDIT', 'FREE_EXPRESS_DELIVERY', 'FREE_STANDARD_DELIVERY', 'COUPON_UNLOCK']
const TRIGGER_ENUM = ['ON_SIGNUP', 'ON_FIRST_ORDER_COMPLETE']

const programProperties = {
  id:                          { type: 'string' },
  name:                        { type: 'string' },
  isActive:                    { type: 'boolean' },
  targetType:                  { type: 'string' },
  targetSegmentId:             { type: ['string', 'null'] },
  priority:                    { type: 'integer' },
  validFrom:                   { type: ['string', 'null'] },
  validUntil:                  { type: ['string', 'null'] },
  referrerRewardType:          { type: 'string' },
  referrerRewardAmount:        { type: ['number', 'null'] },
  referrerRewardCount:         { type: ['integer', 'null'] },
  referrerUnlockCouponId:      { type: ['string', 'null'] },
  referrerTrigger:             { type: 'string' },
  refereeRewardType:           { type: 'string' },
  refereeRewardAmount:         { type: ['number', 'null'] },
  refereeRewardCount:          { type: ['integer', 'null'] },
  refereeUnlockCouponId:       { type: ['string', 'null'] },
  refereeTrigger:              { type: 'string' },
  maxReferralsPerReferrer:     { type: ['integer', 'null'] },
  termsText:                   { type: ['string', 'null'] },
  createdBy:                   { type: ['string', 'null'] },
  createdAt:                   { type: 'string' },
  updatedAt:                   { type: 'string' },
}

const programResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: programProperties },
  },
}

export const listReferralProgramsSchema = {
  tags: ['Referral Programs'],
  summary: 'All referral programs [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: programProperties } },
      },
    },
  },
}

const rewardSideProperties = {
  RewardType:       { type: 'string', enum: REWARD_TYPE_ENUM },
  RewardAmount:     { type: 'number', minimum: 0 },
  RewardCount:      { type: 'integer', minimum: 1 },
  UnlockCouponId:   { type: 'string', format: 'uuid' },
  Trigger:          { type: 'string', enum: TRIGGER_ENUM, default: 'ON_FIRST_ORDER_COMPLETE' },
}

function sidedProperties(prefix) {
  const out = {}
  for (const [suffix, schema] of Object.entries(rewardSideProperties)) {
    out[`${prefix}${suffix}`] = schema
  }
  return out
}

export const createReferralProgramSchema = {
  tags: ['Referral Programs'],
  summary: 'Create referral program [ADMIN]',
  body: {
    type: 'object',
    required: ['name', 'referrerRewardType', 'refereeRewardType'],
    properties: {
      name:                     { type: 'string', minLength: 2, maxLength: 150 },
      isActive:                 { type: 'boolean', default: true },
      targetType:               { type: 'string', enum: ['ALL', 'SEGMENT'], default: 'ALL' },
      targetSegmentId:          { type: 'string', format: 'uuid' },
      priority:                 { type: 'integer', default: 0 },
      validFrom:                { type: 'string', format: 'date-time' },
      validUntil:               { type: 'string', format: 'date-time' },
      maxReferralsPerReferrer:  { type: 'integer', minimum: 1 },
      termsText:                { type: 'string' },
      ...sidedProperties('referrer'),
      ...sidedProperties('referee'),
    },
  },
  response: { 201: programResponse },
}

export const updateReferralProgramSchema = {
  tags: ['Referral Programs'],
  summary: 'Update referral program [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:                     { type: 'string', minLength: 2, maxLength: 150 },
      isActive:                 { type: 'boolean' },
      targetType:               { type: 'string', enum: ['ALL', 'SEGMENT'] },
      targetSegmentId:          { type: ['string', 'null'], format: 'uuid' },
      priority:                 { type: 'integer' },
      validFrom:                { type: ['string', 'null'], format: 'date-time' },
      validUntil:               { type: ['string', 'null'], format: 'date-time' },
      maxReferralsPerReferrer:  { type: ['integer', 'null'], minimum: 1 },
      termsText:                { type: ['string', 'null'] },
      ...sidedProperties('referrer'),
      ...sidedProperties('referee'),
    },
  },
  response: { 200: programResponse },
}

export const deleteReferralProgramSchema = {
  tags: ['Referral Programs'],
  summary: 'Delete referral program [ADMIN]',
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
