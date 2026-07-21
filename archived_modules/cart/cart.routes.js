import { CartController } from './cart.controller.js'
import { CartService } from './cart.service.js'
import { CartRepository } from './cart.repository.js'
import { BillSummaryService } from './bill-summary.service.js'
import { FeeConfigRepository } from '../../src/modules/fee-config/fee-config.repository.js'
import { FeeConfigService } from '../../src/modules/fee-config/fee-config.service.js'
import {
  getCartSchema,
  addItemSchema,
  updateItemSchema,
  removeItemSchema,
  clearCartSchema,
  validateCartSchema,
  getCartSummarySchema,
  updateTipSchema,
  updateDeliveryInstructionsSchema,
} from './cart.schema.js'

/**
 * Cart routes plugin
 * Prefix: /api/v1/cart
 * All routes require authentication
 */
export default async function cartRoutes(fastify) {
  const repository = new CartRepository()
  const service = new CartService(repository)
  const feeConfigRepository = new FeeConfigRepository()
  const feeConfigService = new FeeConfigService(feeConfigRepository)
  const billSummaryService = new BillSummaryService({
    cartService: service,
    feeConfigService,
    cartRepository: repository,
  })
  const controller = new CartController(service, billSummaryService, repository)

  // All cart routes require auth
  fastify.addHook('preHandler', fastify.authenticate)

  // GET / — Get current cart
  fastify.get('/', {
    schema: getCartSchema,
  }, controller.get.bind(controller))

  // GET /summary — Full bill breakdown
  fastify.get('/summary', {
    schema: getCartSummarySchema,
  }, controller.getSummary.bind(controller))

  // POST /items — Add item to cart
  fastify.post('/items', {
    schema: addItemSchema,
  }, controller.addItem.bind(controller))

  // PUT /items/:productId — Update quantity
  fastify.put('/items/:productId', {
    schema: updateItemSchema,
  }, controller.updateItem.bind(controller))

  // DELETE /items/:productId — Remove item
  fastify.delete('/items/:productId', {
    schema: removeItemSchema,
  }, controller.removeItem.bind(controller))

  // DELETE / — Clear cart
  fastify.delete('/', {
    schema: clearCartSchema,
  }, controller.clear.bind(controller))

  // POST /validate — Validate cart before checkout
  fastify.post('/validate', {
    schema: validateCartSchema,
  }, controller.validate.bind(controller))

  // PUT /tip — Save tip amount
  fastify.put('/tip', {
    schema: updateTipSchema,
  }, controller.updateTip.bind(controller))

  // PUT /delivery-instructions — Save delivery instructions
  fastify.put('/delivery-instructions', {
    schema: updateDeliveryInstructionsSchema,
  }, controller.updateInstructions.bind(controller))
}
