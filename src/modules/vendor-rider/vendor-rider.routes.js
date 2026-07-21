import { VendorRiderController } from './vendor-rider.controller.js'
import { VendorRiderService } from './vendor-rider.service.js'

/**
 * Vendor Rider routes plugin
 * Prefix: /api/v1/vendor/rider
 *
 * The restricted job-fulfillment surface for a vendor's own delivery
 * riders — the mirror image of the restriction added to
 * /api/v1/vendor/orders (which now rejects VENDOR_RIDER sessions).
 *
 * Endpoints:
 *   GET  /jobs                              — list this rider's assigned jobs
 *   GET  /jobs/:orderId                     — job detail (address, lines)
 *   POST /jobs/:orderId/pickup-photos       — save garment condition photos
 *   POST /jobs/:orderId/pickup-otp/verify   — confirm pickup
 *   POST /jobs/:orderId/delivery-otp/verify — confirm delivery
 */
export default async function vendorRiderRoutes(fastify) {
  const service = new VendorRiderService()
  const controller = new VendorRiderController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  // Only VENDOR_RIDER sessions use this surface.
  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole !== 'VENDOR_RIDER') {
      return reply.code(403).send({
        success: false,
        message: 'This endpoint is for vendor riders only',
        code: 'FORBIDDEN',
      })
    }
  })

  const orderIdParams = {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
    },
  }

  fastify.get('/jobs', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'List this rider\'s assigned jobs',
      security: [{ bearerAuth: [] }],
    },
  }, controller.listJobs.bind(controller))

  fastify.get('/jobs/:orderId', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Get job detail',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
    },
  }, controller.getJobDetail.bind(controller))

  fastify.post('/jobs/:orderId/pickup-photos', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Save garment condition photos captured at pickup',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['photos'],
        properties: {
          photos: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['url', 'is_grouped'],
              properties: {
                url: { type: 'string' },
                order_line_id: { type: 'string', format: 'uuid', nullable: true },
                is_grouped: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, controller.submitPickupPhotos.bind(controller))

  fastify.post('/jobs/:orderId/pickup-otp/verify', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Verify pickup OTP and mark the order picked up',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['otp'],
        properties: { otp: { type: 'string', minLength: 6, maxLength: 6 } },
      },
    },
  }, controller.verifyPickupOtp.bind(controller))

  fastify.post('/jobs/:orderId/delivery-otp/verify', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Verify delivery OTP and mark the order delivered',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['otp'],
        properties: { otp: { type: 'string', minLength: 6, maxLength: 6 } },
      },
    },
  }, controller.verifyDeliveryOtp.bind(controller))
}
