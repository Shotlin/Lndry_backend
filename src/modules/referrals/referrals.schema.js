/**
 * Referrals JSON Schemas — customer-facing "Refer & Earn" endpoints.
 */

export const getMySummarySchema = {
  tags: ['Referrals'],
  summary: 'Current customer\'s referral code, stats, and active program terms',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            referralCode: { type: ['string', 'null'] },
            totalReferred: { type: 'integer' },
            pending: { type: 'integer' },
            completed: { type: 'integer' },
            totalWalletEarned: { type: 'number' },
            activeProgram: {
              type: ['object', 'null'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                referrerRewardType: { type: 'string' },
                referrerRewardAmount: { type: ['number', 'null'] },
                referrerRewardCount: { type: ['integer', 'null'] },
                referrerTrigger: { type: 'string' },
                refereeRewardType: { type: 'string' },
                refereeRewardAmount: { type: ['number', 'null'] },
                refereeRewardCount: { type: ['integer', 'null'] },
                refereeTrigger: { type: 'string' },
                termsText: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  },
}

export const getMyHistorySchema = {
  tags: ['Referrals'],
  summary: 'Current customer\'s referral timeline (paginated)',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              refereeName: { type: ['string', 'null'] },
              refereePhoneMasked: { type: ['string', 'null'] },
              refereeSignedUpAt: { type: 'string' },
              refereeFirstOrderCompletedAt: { type: ['string', 'null'] },
              referrerRewardStatus: { type: 'string' },
              referrerRewardGrantedAt: { type: ['string', 'null'] },
            },
          },
        },
        pagination: { type: 'object' },
      },
    },
  },
}
