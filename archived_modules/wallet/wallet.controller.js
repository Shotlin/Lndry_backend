import { success, error } from '../../src/utils/apiResponse.js'

/**
 * Wallet controller — thin HTTP layer
 */
export class WalletController {
  constructor(service) {
    this.service = service
  }

  /**
   * Get wallet balance
   */
  async getWallet(request, reply) {
    const wallet = await this.service.getWallet(request.user.id)
    return reply.send(success(wallet, 'Wallet fetched'))
  }

  /**
   * Get wallet transactions
   */
  async getTransactions(request, reply) {
    const { transactions, pagination } = await this.service.getTransactions(
      request.user.id,
      request.query
    )
    return reply.send(success(transactions, 'Transactions fetched', { pagination }))
  }

  /**
   * Create a Razorpay order for wallet top-up
   */
  async createTopUp(request, reply) {
    const result = await this.service.createTopUp(request.user.id, request.body.amount)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'TOPUP_CREATE_FAILED'))
    }
    return reply.send(success(result.data, 'Top-up order created'))
  }

  /**
   * Verify top-up payment and credit wallet
   */
  async verifyTopUp(request, reply) {
    const result = await this.service.verifyTopUp(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'TOPUP_VERIFY_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Wallet credited')
    )
  }

  /**
   * Admin/internal only: add money to wallet directly
   */
  async addMoney(request, reply) {
    const result = await this.service.addMoney(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'WALLET_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Money added')
    )
  }

  /**
   * Pay for order from wallet
   */
  async payFromWallet(request, reply) {
    const result = await this.service.payFromWallet(request.user.id, request.body.orderId)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'WALLET_PAY_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Payment successful')
    )
  }

  /**
   * Transfer money to another user
   */
  async transfer(request, reply) {
    const result = await this.service.transfer(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'TRANSFER_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Transfer successful')
    )
  }

  /**
   * Admin: credit user wallet
   */
  async adminCredit(request, reply) {
    const result = await this.service.adminCredit(request.params.userId, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'CREDIT_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Wallet credited')
    )
  }
}
