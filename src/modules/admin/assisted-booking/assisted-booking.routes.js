import { AssistedBookingController } from './assisted-booking.controller.js'
import { AssistedBookingService } from './assisted-booking.service.js'
import { getAssistedBookingSchema, updateAssistedBookingSchema } from './assisted-booking.schema.js'

/**
 * Assisted booking admin routes plugin
 * Prefix: /api/v1/admin/assisted-booking
 *
 * The customer-facing read (GET /api/v1/customer/assisted-booking) lives in
 * customers.routes.js next to /faqs and /support-contact.
 */
export default async function assistedBookingRoutes(fastify) {
  const controller = new AssistedBookingController(new AssistedBookingService())

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: getAssistedBookingSchema }, controller.get.bind(controller))
  fastify.put('/', { schema: updateAssistedBookingSchema }, controller.update.bind(controller))
}
