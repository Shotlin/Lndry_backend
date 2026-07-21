import { success } from '../../utils/apiResponse.js'

/**
 * Payment offers controller — thin HTTP layer
 */
export class PaymentOffersController {
  constructor(service) {
    this.service = service
  }

  async getPublic(request, reply) {
    const cartTotal = request.query.cart_total ?? request.query.cartTotal ?? 0
    const offers = await this.service.getPublicOffers(cartTotal)
    return reply.code(200).send(success(offers, 'Payment offers fetched'))
  }

  async getAllAdmin(request, reply) {
    const offers = await this.service.getAllAdmin()
    return reply.code(200).send(success(offers, 'Payment offers fetched'))
  }

  async create(request, reply) {
    const offer = await this.service.create(request.body)
    return reply.code(201).send(success(offer, 'Payment offer created'))
  }

  async update(request, reply) {
    const offer = await this.service.update(request.params.id, request.body)
    return reply.code(200).send(success(offer, 'Payment offer updated'))
  }

  async delete(request, reply) {
    await this.service.delete(request.params.id)
    return reply.code(200).send(success(null, 'Payment offer deleted'))
  }
}
