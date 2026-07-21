import { PaymentOffersController } from './payment-offers.controller.js'
import { PaymentOffersService } from './payment-offers.service.js'
import { PaymentOffersRepository } from './payment-offers.repository.js'
import {
  getPaymentOffersSchema,
  getAdminPaymentOffersSchema,
  createPaymentOfferSchema,
  updatePaymentOfferSchema,
  deletePaymentOfferSchema,
} from './payment-offers.schema.js'

/**
 * Payment offers routes
 * Public: GET /api/v1/payment-offers
 */
export default async function paymentOffersRoutes(fastify) {
  const repository = new PaymentOffersRepository()
  const service = new PaymentOffersService(repository)
  const controller = new PaymentOffersController(service)

  fastify.get('/', {
    schema: getPaymentOffersSchema,
  }, controller.getPublic.bind(controller))
}

/**
 * Admin payment-offers routes
 * Prefix: /api/v1/admin/payment-offers
 */
export async function adminPaymentOffersRoutes(fastify) {
  const repository = new PaymentOffersRepository()
  const service = new PaymentOffersService(repository)
  const controller = new PaymentOffersController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: getAdminPaymentOffersSchema,
    preHandler: adminAuth,
  }, controller.getAllAdmin.bind(controller))

  fastify.post('/', {
    schema: createPaymentOfferSchema,
    preHandler: adminAuth,
  }, controller.create.bind(controller))

  fastify.put('/:id', {
    schema: updatePaymentOfferSchema,
    preHandler: adminAuth,
  }, controller.update.bind(controller))

  fastify.delete('/:id', {
    schema: deletePaymentOfferSchema,
    preHandler: adminAuth,
  }, controller.delete.bind(controller))
}
