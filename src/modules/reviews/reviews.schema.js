export const getProductReviewsSchema = {
  tags: ['Reviews'],
  summary: 'Get reviews for a product',
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 10 },
    },
  },
}

export const checkReviewEligibilitySchema = {
  tags: ['Reviews'],
  summary: 'Check whether the current user can review a product',
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
}

export const createReviewSchema = {
  tags: ['Reviews'],
  summary: 'Create a product review',
  body: {
    type: 'object',
    required: ['productId', 'orderId', 'rating'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      rating: { type: 'number', minimum: 1, maximum: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  },
}

export const updateReviewSchema = {
  tags: ['Reviews'],
  summary: 'Update a review',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      rating: { type: 'number', minimum: 1, maximum: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  },
}

export const deleteReviewSchema = {
  tags: ['Reviews'],
  summary: 'Delete a review',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getMyReviewsSchema = {
  tags: ['Reviews'],
  summary: 'Get my reviews',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 10 },
    },
  },
}

export const getVendorReviewsSchema = {
  tags: ['Reviews'],
  summary: 'Get reviews for a vendor',
  params: {
    type: 'object',
    required: ['vendorId'],
    properties: {
      vendorId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1, minimum: 1 },
      limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
    },
  },
}

export const checkOrderReviewEligibilitySchema = {
  tags: ['Reviews'],
  summary: 'Check if an order is review-eligible',
  params: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
    },
  },
}

export const createVendorReviewSchema = {
  tags: ['Reviews'],
  summary: 'Create a review for a vendor/order',
  body: {
    type: 'object',
    required: ['order_id', 'vendor_rating'],
    properties: {
      order_id: { type: 'string', format: 'uuid' },
      vendor_rating: { type: 'integer', minimum: 1, maximum: 5 },
      rider_rating: { type: 'integer', minimum: 1, maximum: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  },
}

export const updateVendorReviewSchema = {
  tags: ['Reviews'],
  summary: 'Update a review within the allowed period',
  params: {
    type: 'object',
    required: ['reviewId'],
    properties: {
      reviewId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      vendor_rating: { type: 'integer', minimum: 1, maximum: 5 },
      rider_rating: { type: 'integer', minimum: 1, maximum: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  },
}

export const deleteVendorReviewSchema = {
  tags: ['Reviews'],
  summary: 'Soft-delete a review',
  params: {
    type: 'object',
    required: ['reviewId'],
    properties: {
      reviewId: { type: 'string', format: 'uuid' },
    },
  },
}

