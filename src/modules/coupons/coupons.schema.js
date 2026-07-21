/**
 * Coupons JSON Schemas
 */

const couponProperties = {
  id:              { type: 'string' },
  code:            { type: 'string' },
  description:     { type: ['string', 'null'] },
  discountType:    { type: 'string' },
  discountValue:   { type: 'number' },
  discountAmount:  { type: ['number', 'null'] },
  minOrderAmount:  { type: 'number' },
  maxDiscount:     { type: ['number', 'null'] },
  usageLimit:      { type: ['integer', 'null'] },
  usedCount:       { type: 'integer' },
  perUserLimit:    { type: 'integer' },
  validFrom:       { type: ['string', 'null'] },
  validUntil:      { type: ['string', 'null'] },
  isActive:        { type: 'boolean' },
  createdAt:       { type: 'string' },
  terms:           { type: ['string', 'null'] },
}

const couponResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: couponProperties },
  },
}

export const validateCouponSchema = {
  tags: ['Coupons'],
  summary: 'Validate coupon code for cart',
  body: {
    type: 'object',
    required: ['code', 'cartTotal'],
    properties: {
      code:      { type: 'string', minLength: 1, maxLength: 50 },
      cartTotal: { type: 'number', minimum: 0 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            valid:          { type: 'boolean' },
            discount:       { type: 'number' },
            discountType:   { type: 'string' },
            discountValue:  { type: 'number' },
            description:    { type: ['string', 'null'] },
            terms:          { type: ['string', 'null'] },
            minOrderAmount: { type: 'number' },
            maxDiscount:    { type: ['number', 'null'] },
            code:           { type: 'string' },
            couponId:       { type: ['string', 'null'] },
            isDemo:         { type: 'boolean' },
          },
        },
      },
    },
  },
}

export const availableCouponsSchema = {
  tags: ['Coupons'],
  summary: 'List available coupons for user',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: couponProperties } },
      },
    },
  },
}

export const listCouponsAdminSchema = {
  tags: ['Coupons'],
  summary: 'All coupons [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      page:  { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array' },
        pagination: { type: 'object' },
      },
    },
  },
}

export const createCouponSchema = {
  tags: ['Coupons'],
  summary: 'Create coupon [HQ or shop staff with shop_coupons.create]',
  body: {
    type: 'object',
    required: ['code', 'discountType', 'discountValue'],
    properties: {
      code:                  { type: 'string', minLength: 2, maxLength: 50 },
      description:           { type: 'string', maxLength: 500 },
      discountType:          { type: 'string', enum: ['PERCENTAGE', 'FLAT'] },
      discountValue:         { type: 'number', minimum: 0.01 },
      minOrderAmount:        { type: 'number', minimum: 0, default: 0 },
      maxDiscount:           { type: 'number', minimum: 0 },
      usageLimit:            { type: 'integer', minimum: 1 },
      perUserLimit:          { type: 'integer', minimum: 1, default: 1 },
      validFrom:             { type: 'string', format: 'date-time' },
      validUntil:            { type: 'string', format: 'date-time' },
      couponType:            { type: 'string', enum: ['PLATFORM_COUPON', 'SHOP_COUPON', 'CATEGORY_COUPON', 'PRODUCT_COUPON', 'DELIVERY_COUPON'] },
      absorber:              { type: 'string', enum: ['PLATFORM', 'SHOP'] },
      shopId:                { type: 'string', format: 'uuid' },
      applicableShopIds:     { type: 'array', items: { type: 'string', format: 'uuid' } },
      applicableCategoryIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: 'array', items: { type: 'string', format: 'uuid' } },
      usageLimitTotal:       { type: 'integer', minimum: 1 },
      usageLimitPerUser:     { type: 'integer', minimum: 1, default: 1 },
    },
  },
  response: { 201: couponResponse },
}

export const updateCouponSchema = {
  tags: ['Coupons'],
  summary: 'Update coupon [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      code:            { type: 'string', minLength: 2, maxLength: 50 },
      description:     { type: 'string', maxLength: 500 },
      discountType:    { type: 'string', enum: ['PERCENTAGE', 'FLAT'] },
      discountValue:   { type: 'number', minimum: 0.01 },
      minOrderAmount:  { type: 'number', minimum: 0 },
      maxDiscount:     { type: 'number', minimum: 0 },
      usageLimit:      { type: 'integer', minimum: 1 },
      perUserLimit:    { type: 'integer', minimum: 1 },
      validFrom:       { type: 'string', format: 'date-time' },
      validUntil:      { type: 'string', format: 'date-time' },
      isActive:        { type: 'boolean' },
    },
  },
  response: { 200: couponResponse },
}

export const deleteCouponSchema = {
  tags: ['Coupons'],
  summary: 'Delete coupon [ADMIN]',
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
