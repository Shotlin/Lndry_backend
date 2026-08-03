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
 *   POST /jobs/:orderId/start-pickup        — mark "on my way" (GOING_FOR_PICKUP)
 *   POST /jobs/:orderId/measurements        — record corrected weight/piece-count (applies immediately)
 *   POST /jobs/:orderId/pickup-photos       — save garment condition photos
 *   POST /jobs/:orderId/pickup-otp/verify   — confirm pickup
 *   POST /jobs/:orderId/start-delivery      — mark "on my way" (OUT_FOR_DELIVERY)
 *   POST /jobs/:orderId/collect-balance     — confirm COD cash balance collected
 *   POST /jobs/:orderId/delivery-otp/verify — confirm delivery
 */
export default async function vendorRiderRoutes(fastify) {
  const service = new VendorRiderService({ fastify })
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

  fastify.post('/jobs/:orderId/start-pickup', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Mark rider as on the way to pickup (GOING_FOR_PICKUP)',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
    },
  }, controller.startPickup.bind(controller))

  fastify.post('/jobs/:orderId/measurements', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Record the rider\'s corrected weight/piece-count at pickup (applies immediately, no customer approval)',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        properties: {
          confirmed_weight_kg: { type: 'number', minimum: 0.1 },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['order_line_id', 'confirmed_quantity'],
              properties: {
                order_line_id: { type: 'string', format: 'uuid' },
                confirmed_quantity: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
  }, controller.submitMeasurements.bind(controller))

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

  fastify.post('/jobs/:orderId/start-delivery', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Mark rider as on the way to deliver (OUT_FOR_DELIVERY)',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
    },
  }, controller.startDelivery.bind(controller))

  fastify.post('/jobs/:orderId/collect-balance', {
    schema: {
      tags: ['Vendor Rider'],
      summary: 'Confirm cash collected for a COD order\'s balance at delivery',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
    },
  }, controller.collectBalance.bind(controller))

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
