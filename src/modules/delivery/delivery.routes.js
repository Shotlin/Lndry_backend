// PHASE 1 SCOPE: No live tracking for customers. 
// Rider uses external Google Maps for navigation.
// Customer sees status timeline only (not GPS coordinates).

// INTERNAL ONLY — Phase 1 excludes customer live-map. Do not expose to customer UI.
// All routes in this module are restricted to authenticated RIDER roles.

import { DeliveryController } from './delivery.controller.js'
import { DeliveryService } from './delivery.service.js'
import { DeliveryRepository } from './delivery.repository.js'
import {
  getAssignedOrdersSchema,
  acceptOrderSchema,
  rejectOrderSchema,
  markPickedUpSchema,
  markDeliveredSchema,
  uploadProofSchema,
  getStatsSchema,
  getEarningsSchema,
  getPayoutsSchema,
  updateLocationSchema,
  toggleOnlineSchema,
  getProfileSchema,
  getHistorySchema,
  getDocumentsSchema,
  uploadDocumentSchema,
  verifyPickupOtpSchema,
  verifyDeliveryOtpSchema,
} from './delivery.schema.js'

/**
 * Delivery routes plugin
 * Prefix: /api/v1/delivery
 * Requires DELIVERY role
 */
export default async function deliveryRoutes(fastify) {
  const repository = new DeliveryRepository()
  const service = new DeliveryService(repository, fastify)
  const controller = new DeliveryController(service)

  // All routes require authentication and RIDER role
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.authorize(['RIDER']))

  // GET /profile — Rider profile
  fastify.get('/profile', {
    schema: getProfileSchema,
  }, controller.getProfile.bind(controller))

  // GET /documents — Get rider documents
  fastify.get('/documents', {
    schema: getDocumentsSchema,
  }, controller.getDocuments.bind(controller))

  // POST /documents/:type — Upload specific document type
  fastify.post('/documents/:type', {
    schema: uploadDocumentSchema,
  }, controller.uploadDocument.bind(controller))

  // POST /documents — Upload document via form data
  fastify.post('/documents', {
    schema: uploadDocumentSchema,
  }, controller.uploadDocument.bind(controller))

  // PATCH /toggle-online — Go online/offline
  fastify.patch('/toggle-online', {
    schema: toggleOnlineSchema,
  }, controller.toggleOnline.bind(controller))

  // GET /assignments — Get assigned orders (LNDRY-API-001 list assignments)
  fastify.get('/assignments', {
    schema: getAssignedOrdersSchema,
  }, controller.getAssignedOrders.bind(controller))

  // PATCH /assignments/:id/accept — Accept order assignment
  fastify.patch('/assignments/:id/accept', {
    schema: acceptOrderSchema,
  }, controller.acceptOrder.bind(controller))

  // PATCH /assignments/:id/reject — Reject order assignment
  fastify.patch('/assignments/:id/reject', {
    schema: rejectOrderSchema,
  }, controller.rejectOrder.bind(controller))

  // PATCH /assignments/:id/pickup — Mark picked up
  fastify.patch('/assignments/:id/pickup', {
    schema: markPickedUpSchema,
  }, controller.markPickedUp.bind(controller))

  // PATCH /assignments/:id/deliver — Mark delivered
  fastify.patch('/assignments/:id/deliver', {
    schema: markDeliveredSchema,
  }, controller.markDelivered.bind(controller))

  // POST /assignments/:id/proof — Upload delivery proof photo
  fastify.post('/assignments/:id/proof', {
    schema: uploadProofSchema,
  }, controller.uploadProof.bind(controller))

  // GET /stats — Get stats
  fastify.get('/stats', {
    schema: getStatsSchema,
  }, controller.getStats.bind(controller))

  // GET /earnings — Get rider earnings summary
  fastify.get('/earnings', {
    schema: getEarningsSchema,
  }, controller.getEarnings.bind(controller))

  // GET /payouts — Get rider payout history
  fastify.get('/payouts', {
    schema: getPayoutsSchema,
  }, controller.getPayouts.bind(controller))

  // PATCH /location — Update location
  fastify.patch('/location', {
    schema: updateLocationSchema,
  }, controller.updateLocation.bind(controller))

  // GET /history — Delivery history
  fastify.get('/history', {
    schema: getHistorySchema,
  }, controller.getHistory.bind(controller))

  // GET /store-info — Store location for map
  fastify.get('/store-info', controller.getStoreInfo.bind(controller))

  // POST /assignments/:id/verify-pickup-otp — Verify pickup OTP
  fastify.post('/assignments/:id/verify-pickup-otp', {
    schema: verifyPickupOtpSchema,
  }, controller.verifyPickupOtp.bind(controller))

  // POST /assignments/:id/verify-delivery-otp — Verify delivery OTP
  fastify.post('/assignments/:id/verify-delivery-otp', {
    schema: verifyDeliveryOtpSchema,
  }, controller.verifyDeliveryOtp.bind(controller))
}
