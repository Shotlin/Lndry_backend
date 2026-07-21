import crypto from 'node:crypto'
import { getClient } from '../../src/config/database.js'
import { env } from '../../src/config/env.js'
import { orderQueue } from '../../src/config/bullmq.js'
import { logger } from '../../src/config/logger.js'
import { razorpay } from '../../src/config/razorpay.js'
import { getOffsetLimit, buildPagination } from '../../src/utils/paginate.js'
import { OrdersRepository } from '../../src/modules/orders/orders.repository.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Wallet service — business logic for digital wallet
 */
export class WalletService {
  constructor(repository) {
    this.repo = repository
    this.ordersRepo = new OrdersRepository()
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
   * Pay for an order from wallet balance
   */
  async payFromWallet(userId, orderId) {
    const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.paymentMethod !== 'WALLET') {
      return { success: false, message: 'Order is not set for wallet payment' }
    }

    if (order.paymentStatus === 'PAID') {
      return { success: false, message: 'Order is already paid' }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      const wallet = await this.repo.getForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      if (wallet.balance < order.totalAmount) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: `Insufficient balance. Need ₹${order.totalAmount}, have ₹${wallet.balance}`,
        }
      }

      const result = await this.repo.debit(
        client,
        wallet.id,
        order.totalAmount,
        `Payment for order ${order.orderNumber}`,
        order.id
      )

      await client.query('COMMIT')

      // Update order payment status
      await this.ordersRepo.updateStatus(orderId, 'WAITING_FOR_VENDOR_CONFIRMATION', {
        paymentStatus: 'PAID',
      })
      try {
        await orderQueue.add(
          'auto-reject',
          {
            type: 'auto-reject',
            orderId,
          },
          {
            jobId: `auto-reject-${orderId}`,
            delay: 15 * 60 * 1000,
            removeOnComplete: true,
          }
        )
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Failed to queue auto-reject on wallet payment')
      }

      // Clear cart and send notification AFTER successful wallet deduction
      try {
        const { CartRepository } = await import('../../src/modules/cart/cart.repository.js')
        const cartRepo = new CartRepository()
        await cartRepo.clearCart(userId)
        await cartRepo.clearExtras(userId)
      } catch (cartErr) {
        logger.warn({ err: cartErr.message, userId }, 'Cart clear after wallet pay failed (non-critical)')
      }

      // Send "Order placed" notification only after confirmed payment
      try {
        const { NotificationsRepository } = await import('../../src/modules/notifications/notifications.repository.js')
        const { NotificationsService } = await import('../../src/modules/notifications/notifications.service.js')
        const { buildCustomerOrderEventNotification } = await import('../../src/modules/notifications/customer-order-event.helper.js')
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        await notifService.sendNotification(userId, buildCustomerOrderEventNotification({
          orderId: order.id,
          orderNumber: order.orderNumber || order.order_number,
          timelineType: 'ORDER_PLACED',
          status: 'CONFIRMED',
        }))
      } catch (notifErr) {
        logger.warn({ err: notifErr.message, orderId }, 'Notification after wallet pay failed (non-critical)')
      }

      logger.info(
        { userId, orderId, amount: order.totalAmount },
        'Wallet payment successful'
      )

      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, orderId }, 'Wallet payment failed')
      return { success: false, message: 'Payment failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Transfer money to another user by phone number
   */
  async transfer(userId, { phone, amount, description }) {
    const recipient = await this.repo.findUserByPhone(phone)
    if (!recipient) {
      return { success: false, message: 'Recipient not found' }
    }

    if (recipient.id === userId) {
      return { success: false, message: 'Cannot transfer to yourself' }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      // Lock sender wallet
      const senderWallet = await this.repo.getForUpdate(client, userId)
      if (!senderWallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      if (senderWallet.balance < amount) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Insufficient balance' }
      }

      // Ensure recipient wallet exists
      await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [recipient.id]
      )

      // Lock recipient wallet
      const recipientWallet = await this.repo.getForUpdate(client, recipient.id)

      // Debit sender
      const senderResult = await this.repo.debit(
        client,
        senderWallet.id,
        amount,
        description || `Transfer to ${recipient.name || recipient.phone}`,
        `transfer:${recipient.id}`
      )

      // Credit recipient
      await this.repo.credit(
        client,
        recipientWallet.id,
        amount,
        `Transfer from user`,
        `transfer:${userId}`
      )

      await client.query('COMMIT')

      logger.info(
        { from: userId, to: recipient.id, amount },
        'Wallet transfer successful'
      )

      return { success: true, ...senderResult }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, amount }, 'Wallet transfer failed')
      return { success: false, message: 'Transfer failed: ' + err.message }
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
    const { query: dbQuery } = await import('../../src/config/database.js')

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

  async _queueAutoAssign(orderId, source = 'WALLET_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        {
          type: 'auto-assign',
          orderId,
          source,
        },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }
}
