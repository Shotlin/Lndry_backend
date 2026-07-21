import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { getSocketIo } from '../plugins/socketio.plugin.js'
import { notificationQueue } from '../config/bullmq.js'

/**
 * Auto-reject WAITING_VENDOR_CONFIRMATION orders after 15 minutes.
 */
export function createVendorAutoRejectProcessor() {
  return async (job) => {
    const { orderId } = job.data
    logger.info({ orderId }, 'Running vendor auto-reject job')

    // 1. Fetch order details
    const { rows } = await query(
      'SELECT id, status, user_id, vendor_id, pickup_date, vendor_slot_id FROM orders WHERE id = $1',
      [orderId]
    )

    const order = rows[0]
    if (!order) {
      logger.warn({ orderId }, 'Order not found for auto-reject')
      return
    }

    if (order.status !== 'WAITING_VENDOR_CONFIRMATION') {
      logger.info({ orderId, status: order.status }, 'Order is no longer waiting for vendor confirmation')
      return
    }

    // 2. Perform database updates in a transaction
    await query(
      "UPDATE orders SET status = 'AUTO_REJECTED', updated_at = NOW() WHERE id = $1",
      [orderId]
    )

    // Write immutable event to order_events
    await query(
      `INSERT INTO order_events (order_id, old_status, new_status, actor_id, actor_role, note)
       VALUES ($1, 'WAITING_VENDOR_CONFIRMATION', 'AUTO_REJECTED', NULL, 'SYSTEM', 'Auto-rejected due to vendor response timeout')`,
      [orderId]
    )

    // Release capacity holds
    await query(
      'DELETE FROM slot_holds WHERE user_id = $1 AND slot_id = $2 AND booking_date = $3',
      [order.user_id, order.vendor_slot_id, order.pickup_date]
    )

    // 3. Trigger notification flow
    if (notificationQueue) {
      await notificationQueue.add('order-status-changed', {
        orderId,
        status: 'AUTO_REJECTED',
      })
    }

    // 4. Notify via Socket.IO
    const io = getSocketIo()
    if (io) {
      io.to(`order:${orderId}`).emit('order.updated', {
        order_id: orderId,
        status: 'AUTO_REJECTED',
        event_version: 1,
      })
      io.to(`user:${order.user_id}`).emit('order.updated', {
        order_id: orderId,
        status: 'AUTO_REJECTED',
      })
      io.to(`shop:${order.vendor_id}`).emit('order.updated', {
        order_id: orderId,
        status: 'AUTO_REJECTED',
      })
    }

    logger.info({ orderId }, 'Order auto-rejected successfully')
  }
}

/**
 * Periodically release expired slot holds and restore capacity.
 */
export function createSlotHoldExpiryProcessor() {
  return async (job) => {
    logger.info('Running slot hold expiry cleanup job')

    // Delete expired holds
    const { rowCount } = await query(
      'DELETE FROM slot_holds WHERE expires_at < NOW()'
    )

    if (rowCount > 0) {
      logger.info({ expiredHoldsDeleted: rowCount }, 'Expired slot holds cleaned up')
    }
  }
}
