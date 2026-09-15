import crypto from 'node:crypto'
import { getClient } from '../../config/database.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { razorpay } from '../../config/razorpay.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'

/**
 * Wallet service — business logic for digital wallet
 */
export class WalletService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Get or create wallet for a user
   */
  async getWallet(userId) {
    return this.repo.getOrCreate(userId)
  }

  /**
   * Get wallet transactions (paginated)
   */
  async getTransactions(userId, filters) {
    const wallet = await this.repo.getOrCreate(userId)
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { transactions, total } = await this.repo.getTransactions(wallet.id, {
      limit,
      offset,
      type: filters.type,
    })

    return {
      transactions,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: get all transactions across all users (paginated, filterable)
   */
  async getAdminTransactions(filters = {}) {
    const page = filters.page || 1
    const limit = filters.limit || 20
    const offset = (page - 1) * limit

    const { transactions, total } = await this.repo.getAdminTransactions({
      limit,
      offset,
      type: filters.type,
      userId: filters.userId,
    })

    return {
      transactions,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  async _getOrCreateWalletForUpdate(client, userId) {
    let wallet = await this.repo.getForUpdate(client, userId)
    if (wallet) return wallet

    await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    )

    wallet = await this.repo.getForUpdate(client, userId)
    return wallet
  }

  /**
   * Step 1: create a Razorpay order for wallet top-up.
   * This does not credit the wallet.
   */
  async createTopUp(userId, amount) {
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const normalizedAmount = Number(amount)
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 10 || normalizedAmount > 10000) {
      return { success: false, message: 'Amount must be between ₹10 and ₹10,000' }
    }

    const wallet = await this.repo.getOrCreate(userId)
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(normalizedAmount * 100),
      currency: 'INR',
      receipt: `topup_${Date.now()}`,
      notes: {
        userId,
        purpose: 'wallet_topup',
      },
    })

    await this.repo.createPendingTopUp(wallet.id, {
      amount: normalizedAmount,
      razorpayOrderId: razorpayOrder.id,
      description: 'Wallet top-up',
    })

    logger.info({ userId, amount: normalizedAmount, razorpayOrderId: razorpayOrder.id }, 'Wallet top-up order created')

    return {
      success: true,
      data: {
        razorpayOrderId: razorpayOrder.id,
        amount: normalizedAmount,
        currency: 'INR',
        keyId: env.RAZORPAY_KEY_ID,
      },
    }
  }

  /**
   * Step 2: verify Razorpay payment and credit wallet exactly once.
   */
  async verifyTopUp(userId, { paymentId, orderId, signature }) {
    if (!paymentId || !orderId || !signature) {
      return { success: false, message: 'Missing payment verification details' }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      const topup = await this.repo.findTopUpByOrderIdForUpdate(client, orderId)
      if (!topup) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Top-up record not found' }
      }

      if (topup.userId !== userId) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Unauthorized' }
      }

      if (topup.status === 'COMPLETED') {
        const wallet = await this._getOrCreateWalletForUpdate(client, userId)
        await client.query('COMMIT')
        return { success: true, wallet, transaction: topup }
      }

      if (topup.status === 'FAILED') {
        await client.query('ROLLBACK')
        return { success: false, message: 'Top-up already marked as failed' }
      }

      const expectedSignature = crypto
        .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex')

      if (expectedSignature !== signature) {
        await this.repo.markTopUpFailed(client, topup.id)
        await client.query('COMMIT')
        logger.warn({ userId, orderId }, 'Wallet top-up signature verification failed')
        return { success: false, message: 'Payment verification failed' }
      }

      const wallet = await this._getOrCreateWalletForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      const result = await this.repo.applyPendingTopUp(
        client,
        wallet.id,
        topup.id,
        topup.amount
      )

      await client.query('COMMIT')

      logger.info({ userId, amount: topup.amount, orderId }, 'Wallet top-up verified and credited')
      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, orderId }, 'Wallet top-up verification failed')
      return { success: false, message: 'Top-up verification failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Internal only: add money to wallet without a payment gateway.
   * Use this for refunds or admin/manual credits, never for customer top-ups.
   */
  async addMoney(userId, { amount, description, referenceId }) {
    const client = await getClient()

    try {
      await client.query('BEGIN')

      const walletForOp = await this._getOrCreateWalletForUpdate(client, userId)
      if (!walletForOp) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Failed to create wallet' }
      }

      const result = await this.repo.credit(
        client,
        walletForOp.id,
        amount,
        description || 'Money added',
        referenceId
      )

      await client.query('COMMIT')

      logger.info({ userId, amount, balance: result.wallet.balance }, 'Wallet credited')
      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, amount }, 'Wallet credit failed')
      return { success: false, message: 'Failed to add money: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Admin: credit a user's wallet (refunds, promotions, etc.)
   */
  async adminCredit(targetUserId, { amount, description, referenceId }) {
    return this.addMoney(targetUserId, {
      amount,
      description: description || 'Admin credit',
      referenceId,
    })
  }

  /**
   * Admin: get wallet overview statistics
   */
  async getAdminStats() {
    const { query: dbQuery } = await import('../../config/database.js')

    const balanceRes = await dbQuery('SELECT COALESCE(SUM(balance), 0) AS total_balance FROM wallets')
    const creditRes = await dbQuery(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'CREDIT' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'"
    )
    const debitRes = await dbQuery(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'DEBIT' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'"
    )
    const refundRes = await dbQuery(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'CREDIT' AND description ILIKE '%refund%' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'"
    )

    return {
      totalBalance: parseFloat(balanceRes.rows[0].total_balance),
      totalAdded: parseFloat(creditRes.rows[0].total),
      totalUsed: parseFloat(debitRes.rows[0].total),
      totalRefunded: parseFloat(refundRes.rows[0].total),
    }
  }
}
