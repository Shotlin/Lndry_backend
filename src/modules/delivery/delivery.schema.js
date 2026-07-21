export const getAssignedOrdersSchema = {
  tags: ['Delivery'],
  summary: 'Get assigned delivery orders',
  querystring: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['ASSIGNED', 'ACCEPTED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
      },
    },
  },
}

export const acceptOrderSchema = {
  tags: ['Delivery'],
  summary: 'Accept delivery assignment',
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
      accept: { type: 'boolean' },
    },
    additionalProperties: true,
  },
}

export const rejectOrderSchema = {
  tags: ['Delivery'],
  summary: 'Reject delivery assignment',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        enum: ['TOO_FAR', 'VEHICLE_ISSUE', 'PERSONAL_REASON', 'OTHER'],
      },
    },
  },
}

export const markPickedUpSchema = {
  tags: ['Delivery'],
  summary: 'Mark order as picked up from store',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    additionalProperties: true,
  },
}

export const markDeliveredSchema = {
  tags: ['Delivery'],
  summary: 'Mark order as delivered (OTP, proof URL, or demo mode)',
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
      otp: { type: 'string', minLength: 4, maxLength: 6 },
      proofPhotoUrl: { type: 'string', format: 'uri' },
      demoMode: { type: 'boolean' },
    },
    anyOf: [
      { required: ['otp'] },
      { required: ['proofPhotoUrl'] },
      {
        required: ['demoMode'],
        properties: {
          demoMode: { const: true },
        },
      },
    ],
  },
}

export const uploadProofSchema = {
  tags: ['Delivery'],
  summary: 'Upload delivery proof photo',
  consumes: ['multipart/form-data', 'application/json'],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getStatsSchema = {
  tags: ['Delivery'],
  summary: 'Get delivery partner statistics',
}

export const getEarningsSchema = {
  tags: ['Delivery'],
  summary: 'Get rider earnings summary',
  querystring: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['today', 'week', 'month', 'all'],
        default: 'month',
      },
    },
  },
}

export const getPayoutsSchema = {
  tags: ['Delivery'],
  summary: 'Get rider payout history',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
}

export const updateLocationSchema = {
  tags: ['Rider Internal'],
  summary: 'Update rider GPS location (RIDER-ONLY, not for customer UI)',
  description: 'INTERNAL ONLY — Phase 1 excludes customer live-map. Do not expose to customer UI.',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['latitude', 'longitude'],
    properties: {
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
    },
  },
}

export const toggleOnlineSchema = {
  tags: ['Delivery'],
  summary: 'Toggle rider online/offline status',
  body: {
    type: 'object',
    required: ['isOnline'],
    properties: {
      isOnline: { type: 'boolean' },
    },
  },
}

export const getProfileSchema = {
  tags: ['Delivery'],
  summary: 'Get rider profile',
}

export const getHistorySchema = {
  tags: ['Delivery'],
  summary: 'Get delivery history',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
}

export const getDocumentsSchema = {
  tags: ['Delivery'],
  summary: 'Get rider documents',
}

export const uploadDocumentSchema = {
  tags: ['Delivery'],
  summary: 'Upload rider document',
  consumes: ['multipart/form-data'],
}

export const verifyPickupOtpSchema = {
  tags: ['Delivery'],
  summary: 'Verify pickup OTP for order',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['otp'],
    properties: {
      otp: { type: 'string', minLength: 4, maxLength: 6 },
    },
  },
}

export const verifyDeliveryOtpSchema = {
  tags: ['Delivery'],
  summary: 'Verify delivery OTP for order',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['otp'],
    properties: {
      otp: { type: 'string', minLength: 4, maxLength: 6 },
    },
  },
}
