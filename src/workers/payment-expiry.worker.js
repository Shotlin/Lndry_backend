/**
 * Payment Expiry Worker
 * Polls every 2 minutes for PENDING online payments past their 15-minute window.
 * Marks them EXPIRED and cancels the associated order.
 *
 * Safe: uses SELECT FOR UPDATE SKIP LOCKED to avoid double-processing
 * on multi-instance deployments.
 *
 * Stock correctness: restores vendor_services.stock_quantity for each
 * cancelled order's items so stock is not permanently lost on payment expiry.
 */
import { getClient } from '../config/database.js'
import { logger } from '../config/logger.js'

let _intervalHandle = null
const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes

export function startPaymentExpiryWorker() {
  if (_intervalHandle) return

  logger.info('Payment expiry worker started (polling every 2 min)')

  _intervalHandle = setInterval(async () => {
    try {
      await _processExpiredPayments()
    } catch (err) {
      logger.error({ err: err.message }, 'Payment expiry worker poll error')
    }
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup
  _processExpiredPayments().catch(err =>
    logger.error({ err: err.message }, 'Payment expiry worker initial poll error')
  )
}

export function stopPaymentExpiryWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Payment expiry worker stopped')
  }
}

async function _processExpiredPayments() {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // 1. Find expired pending payments (new flow with expires_at)
    const { rows: expired } = await client.query(
      `SELECT p.id AS payment_id, p.order_id, p.razorpay_order_id
       FROM payments p
       WHERE p.status = 'PENDING'
         AND p.expires_at IS NOT NULL
         AND p.expires_at <= NOW()
       LIMIT 20
       FOR UPDATE SKIP LOCKED`
    )

    // 2. Also find legacy ONLINE PENDING orders without expires_at older than 30 min
    const { rows: legacy } = await client.query(
      `SELECT id AS order_id, NULL::uuid AS payment_id
       FROM orders
       WHERE status = 'PENDING'
         AND payment_method = 'ONLINE'
         AND payment_status = 'PENDING'
         AND payment_expires_at IS NULL
         AND created_at < NOW() - INTERVAL '30 minutes'
       LIMIT 20
       FOR UPDATE SKIP LOCKED`
    )

    const all = [
      ...expired.map(r => ({ paymentId: r.payment_id, orderId: r.order_id, isLegacy: false })),
      ...legacy.map(r => ({ paymentId: null, orderId: r.order_id, isLegacy: true })),
    ]

    if (all.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    logger.info({ count: all.length, legacy: legacy.length }, 'Processing expired pending payments')

    for (const row of all) {
      // Verify the order is still PENDING before cancelling (idempotency guard)
      const { rows: [orderRow] } = await client.query(
        `SELECT id, status, payment_status, items FROM orders WHERE id = $1 FOR UPDATE`,
        [row.orderId]
      )

      if (!orderRow) {
        logger.warn({ orderId: row.orderId }, 'Payment expiry: order not found, skipping')
        continue
      }

      // Only cancel truly PENDING orders — idempotent guard against double-processing
      if (orderRow.status !== 'PENDING' || orderRow.payment_status !== 'PENDING') {
        logger.info(
          { orderId: row.orderId, status: orderRow.status, paymentStatus: orderRow.payment_status },
          'Payment expiry: order already processed, skipping stock restore'
        )
      } else {
        // Restore vendor_services stock for each item in the order
        const items = typeof orderRow.items === 'string'
          ? JSON.parse(orderRow.items)
          : (orderRow.items || [])

        for (const item of items) {
          const qty = Number(item.quantity)
          if (!qty || qty <= 0) continue

          const shopProductId = item.shopProductId || item.shop_product_id || null
          const productId = item.productId || item.garment_rate_id || null
          const shopId = item.shopId || item.vendor_id || null

          if (shopProductId) {
            // Phase 3 exact path
            await client.query(
              `UPDATE vendor_services
               SET stock_quantity = stock_quantity + $1,
                   is_available = CASE
                     WHEN stock_quantity = 0 AND $1 > 0 THEN true
                     ELSE is_available
                   END,
                   sold_out_at = CASE
                     WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                     ELSE sold_out_at
                   END,
                   updated_at = NOW()
               WHERE id = $2 AND deleted_at IS NULL`,
              [qty, shopProductId]
            )
          } else if (productId && shopId) {
            // Legacy path: resolve via (garment_rate_id, vendor_id)
            await client.query(
              `UPDATE vendor_services
               SET stock_quantity = stock_quantity + $1,
                   is_available = CASE
                     WHEN stock_quantity = 0 AND $1 > 0 THEN true
                     ELSE is_available
                   END,
                   sold_out_at = CASE
                     WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                     ELSE sold_out_at
                   END,
                   updated_at = NOW()
               WHERE garment_rate_id = $2 AND vendor_id = $3 AND deleted_at IS NULL`,
              [qty, productId, shopId]
            )
          }
        }

        logger.info({ orderId: row.orderId, itemCount: items.length }, 'Payment expiry: stock restored for order items')
      }

      if (row.paymentId) {
        await client.query(
          `UPDATE payments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
          [row.paymentId]
        )
      }

      // Also expire any legacy payment records for this order
      if (row.isLegacy) {
        await client.query(
          `UPDATE payments SET status = 'EXPIRED', updated_at = NOW()
           WHERE order_id = $1 AND status = 'PENDING'`,
          [row.orderId]
        )
      }

      await client.query(
        `UPDATE orders
         SET status = 'CANCELLED',
             payment_status = 'EXPIRED',
             cancelled_reason = 'Payment window expired (15 minutes)',
             updated_at = NOW()
         WHERE id = $1
           AND status = 'PENDING'
           AND payment_status = 'PENDING'`,
        [row.orderId]
      )

      logger.info(
        { paymentId: row.paymentId, orderId: row.orderId, isLegacy: row.isLegacy },
        'Expired payment cancelled'
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err: err.message }, 'Payment expiry worker transaction failed')
  } finally {
    client.release()
  }
}
