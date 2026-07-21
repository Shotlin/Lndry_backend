import { success, error } from '../../src/utils/apiResponse.js'

/**
 * Cart controller — thin HTTP layer
 */
export class CartController {
  constructor(service, billSummaryService = null, repository = null) {
    this.service = service
    this.billSummaryService = billSummaryService
    this.repo = repository
  }

  /** GET / */
  async get(request, reply) {
    const cart = await this.service.getCart(request.user.id)
    return reply.code(200).send(success(cart, 'Cart fetched'))
  }

  /** GET /summary */
  async getSummary(request, reply) {
    const summary = await this.billSummaryService.getBillSummary(request.user.id)
    return reply.code(200).send(success(summary, 'Bill summary fetched'))
  }

  /** POST /items */
  async addItem(request, reply) {
    const result = await this.service.addItem(request.user.id, {
      productId: request.body.productId || null,
      shopId: request.body.shopId || null,
      shopProductId: request.body.shopProductId || null,
      quantity: request.body.quantity,
    })
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'CART_ERROR'))
    }
    return reply.code(200).send(success(result.cart, 'Item added to cart'))
  }

  /** PUT /items/:productId */
  async updateItem(request, reply) {
    const result = await this.service.updateItem(
      request.user.id,
      request.params.productId,
      request.body.quantity,
      request.body.shopId || null,
      request.body.shopProductId || null
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'CART_ERROR'))
    }
    return reply.code(200).send(success(result.cart, 'Cart item updated'))
  }

  /** DELETE /items/:productId */
  async removeItem(request, reply) {
    const result = await this.service.removeItem(
      request.user.id,
      request.params.productId,
      request.query?.shopId || null,
      request.query?.shopProductId || null
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, result.code || 'CART_ERROR'))
    }
    return reply.code(200).send(success(result.cart, 'Item removed from cart'))
  }

  /** DELETE / */
  async clear(request, reply) {
    await this.service.clearCart(request.user.id)
    return reply.code(200).send(success(null, 'Cart cleared'))
  }

  /** POST /validate */
  async validate(request, reply) {
    const result = await this.service.validateCart(request.user.id)
    return reply.code(200).send(success(result, 'Cart validated'))
  }

  /** PUT /tip */
  async updateTip(request, reply) {
    await this.repo.setTip(request.user.id, request.body.amount)
    return reply.code(200).send(success({ tipAmount: request.body.amount }, 'Tip updated'))
  }

  /** PUT /delivery-instructions */
  async updateInstructions(request, reply) {
    await this.repo.setInstructions(request.user.id, request.body.instructions)
    return reply.code(200).send(success({
      instructions: request.body.instructions?.trim() || null,
    }, 'Delivery instructions updated'))
  }
}
