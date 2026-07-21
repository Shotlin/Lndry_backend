import { ReviewsController } from './reviews.controller.js'
import { ReviewsService } from './reviews.service.js'
import { ReviewsRepository } from './reviews.repository.js'
import {
  getProductReviewsSchema,
  checkReviewEligibilitySchema,
  createReviewSchema,
  updateReviewSchema,
  deleteReviewSchema,
  getMyReviewsSchema,
  getVendorReviewsSchema,
  checkOrderReviewEligibilitySchema,
  createVendorReviewSchema,
  updateVendorReviewSchema,
  deleteVendorReviewSchema,
} from './reviews.schema.js'

/**
 * Reviews routes plugin
 * Prefix: /api/v1/reviews
 */
export default async function reviewsRoutes(fastify) {
  const repository = new ReviewsRepository()
  const service = new ReviewsService(repository)
  const controller = new ReviewsController(service)

  // ─── LNDRY Vendor Reviews ────────────────────────────────
  // GET /vendors/:vendorId — Get vendor reviews (Public/Customer)
  fastify.get('/vendors/:vendorId', {
    schema: getVendorReviewsSchema,
  }, controller.getVendorReviews.bind(controller))

  // GET /eligibility/:id — Check if order or product is review-eligible
  fastify.get('/eligibility/:id', {
    schema: {
      tags: ['Reviews'],
      summary: 'Check if order or product is review-eligible',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.checkEligibility.bind(controller))

  // ─── Legacy/Compatibility/Shared Reviews ──────────────────
  // GET /garment_rates/:productId — Get product reviews
  fastify.get('/garment_rates/:productId', {
    schema: getProductReviewsSchema,
  }, controller.getProductReviews.bind(controller))

  // POST / — Create review (supports either product review or vendor review)
  fastify.post('/', {
    schema: {
      tags: ['Reviews'],
      summary: 'Create a review',
      body: {
        type: 'object',
        anyOf: [
          {
            required: ['productId', 'orderId', 'rating'],
            properties: {
              productId: { type: 'string', format: 'uuid' },
              orderId: { type: 'string', format: 'uuid' },
              rating: { type: 'number', minimum: 1, maximum: 5 },
              comment: { type: 'string', maxLength: 1000 },
            },
          },
          {
            required: ['order_id', 'vendor_rating'],
            properties: {
              order_id: { type: 'string', format: 'uuid' },
              vendor_rating: { type: 'integer', minimum: 1, maximum: 5 },
              rider_rating: { type: 'integer', minimum: 1, maximum: 5 },
              comment: { type: 'string', maxLength: 1000 },
            },
          },
        ],
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.createReview.bind(controller))

  // PATCH /:id — Update review
  fastify.patch('/:id', {
    schema: {
      tags: ['Reviews'],
      summary: 'Update review',
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
          vendor_rating: { type: 'integer', minimum: 1, maximum: 5 },
          rider_rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 1000 },
        },
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.updateReview.bind(controller))

  // DELETE /:id — Delete review
  fastify.delete('/:id', {
    schema: deleteReviewSchema,
    preHandler: [fastify.authenticate],
  }, controller.deleteReview.bind(controller))

  // GET /my-reviews — Get user's reviews
  fastify.get('/my-reviews', {
    schema: getMyReviewsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getMyReviews.bind(controller))
}

