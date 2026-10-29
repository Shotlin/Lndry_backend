import { notificationQueue, orderQueue } from '../../../config/bullmq.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { InvoicesService } from '../../invoices/invoices.service.js'
import { query as dbQuery, getClient } from '../../../config/database.js'
import { getRazorpay } from '../../../config/razorpay.js'
import ExcelJS from 'exceljs'

const ASSIGNABLE_ORDER_STATUSES = new Set(['CONFIRMED', 'PREPARING', 'PACKED'])
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

const ALLOWED_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
}

const money = (v) => Math.round(Number(v || 0) * 100) / 100

/** Items saved on the order row itself (used when there are no order_lines). */
function itemsFromJson(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list.map((i, idx) => ({
    id: i.id ?? `json-${idx}`,
    name: i.name ?? i.garment_name ?? 'Item',
    quantity: Number(i.quantity ?? i.qty ?? 1),
    unit: i.unit ?? null,
    price: money(i.price),
    total: money(i.total ?? Number(i.price || 0) * Number(i.quantity ?? i.qty ?? 1)),
  }))
}

function presentPayment(p) {
  const amount = money(p.amount)
  const refunded = money(p.refund_amount)
  const hasMoney = ['PAID', 'REFUNDED'].includes(p.status)
  return {
    id: p.id,
    purpose: p.purpose,
    status: p.status,
    method: p.method,
    amount,
    currency: p.currency || 'INR',
    razorpay_order_id: p.razorpay_order_id,
    razorpay_payment_id: p.razorpay_payment_id,
    paid_at: p.paid_at,
    created_at: p.created_at,
    failure_reason: p.failure_reason,
    refunded_amount: refunded,
    refundable_amount: hasMoney ? Math.max(0, money(amount - refunded)) : 0,
    refunds: Array.isArray(p.metadata?.refunds) ? p.metadata.refunds : [],
  }
}

/** What the customer owes, has paid, got back — all in rupees, from the payments ledger. */
export function computeOrderFinancials(order, payments) {
  const hasFinalAmount = Number(order.payable_amount_paise) > 0
  const isEstimate = order.booking_type === 'ASSISTED' && !hasFinalAmount
  const total = hasFinalAmount ? money(order.payable_amount_paise / 100) : money(order.total_amount)
  const paid = money(payments.filter((p) => ['PAID', 'REFUNDED'].includes(p.status)).reduce((s, p) => s + Number(p.amount || 0), 0))
  const refunded = money(payments.reduce((s, p) => s + Number(p.refund_amount || 0), 0))
  const netPaid = money(paid - refunded)
  const cancelled = ['CANCELLED', 'REFUNDED'].includes(order.status)
  const balanceDue = cancelled ? 0 : Math.max(0, money(total - netPaid))
  let paymentState = 'UNPAID'
  if (refunded > 0 && netPaid <= 0) paymentState = 'REFUNDED'
  else if (refunded > 0) paymentState = 'PARTIALLY_REFUNDED'
  else if (paid > 0 && balanceDue <= 0) paymentState = 'PAID'
  else if (paid > 0) paymentState = 'PARTIALLY_PAID'
  return {
    total, paid, refunded, net_paid: netPaid, balance_due: balanceDue, payment_state: paymentState,
    is_estimate: isEstimate,
    breakdown: {
      subtotal: money(order.subtotal), discount: money(order.discount_amount), delivery_fee: money(order.delivery_fee),
      platform_fee: money(order.platform_fee), handling_fee: money(order.handling_fee), late_night_fee: money(order.late_night_fee),
      tax: money(order.tax_amount), tip: money(order.tip_amount),
    },
  }
}

export class AdminOrdersService {
  constructor(repository, fastify) {
    this.repository = repository
    this.fastify = fastify
  }

  async findAll(filters) {
    const offset = ((filters.page || 1) - 1) * (filters.limit || 20)
    const result = await this.repository.findAll({ ...filters, offset, limit: filters.limit || 20 })
    return {
      orders: result.orders,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (filters.limit || 20)),
      },
    }
  }

  async getStatsByStatus() {
    return this.repository.getStatsByStatus()
  }

  async findById(orderId) {
    const [order, items, timeline, payment, payments, delivery] = await Promise.all([
      this.repository.findById(orderId),
      this.repository.getOrderItems(orderId),
      this.repository.getOrderTimeline(orderId),
      this.repository.getOrderPayment(orderId),
      this.repository.getOrderPayments(orderId),
      this.repository.getOrderDelivery(orderId),
    ])
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    const financials = computeOrderFinancials(order, payments)
    return {
      ...order,
      items: items.length ? items : itemsFromJson(order.items),
      timeline,
      payment,
      payments: payments.map(presentPayment),
      financials,
      delivery,
    }
  }

  /**
   * Refund all or part of one payment of an order. Razorpay payments are
   * refunded through the gateway; wallet payments go back to the customer's
   * wallet. Row-locked so a double click can never refund the same money twice.
   * Does not change the order's status — the order lifecycle stays with the
   * vendor/rider workflow.
   */
  async refundPayment(orderId, paymentId, { amount, reason } = {}, adminId, ip) {
    const client = await getClient()
    let result
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT p.*, o.order_number, o.user_id AS order_user_id
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.id = $1 AND p.order_id = $2 FOR UPDATE OF p`,
        [paymentId, orderId]
      )
      const payment = rows[0]
      if (!payment) throw { statusCode: 404, message: 'Payment not found for this order' }
      if (!['PAID', 'REFUNDED'].includes(payment.status)) {
        throw { statusCode: 400, message: 'Only a paid payment can be refunded' }
      }

      const paid = Number(payment.amount)
      const alreadyRefunded = Number(payment.refund_amount || 0)
      const refundable = Math.round((paid - alreadyRefunded) * 100) / 100
      if (refundable <= 0) throw { statusCode: 400, message: 'This payment has already been fully refunded' }
      const refundAmount = amount == null ? refundable : Math.round(Number(amount) * 100) / 100
      if (!(refundAmount > 0)) throw { statusCode: 400, message: 'Enter a valid refund amount' }
      if (refundAmount > refundable) {
        throw { statusCode: 400, message: `Refund cannot exceed the ₹${refundable.toFixed(2)} still refundable on this payment` }
      }
      const note = (reason || '').trim() || 'Admin initiated refund'

      let refundId
      let destination
      if (payment.method === 'LNDRY_WALLET' || !payment.razorpay_payment_id) {
        const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
        await new AdminCustomersRepository().creditWallet(
          payment.order_user_id, refundAmount, `Refund for order ${payment.order_number}: ${note}`
        )
        refundId = `WALLET-${Date.now()}`
        destination = 'WALLET'
      } else {
        const rzp = await getRazorpay()
        if (!rzp) throw { statusCode: 503, message: 'Razorpay is not configured, so an online refund cannot be sent' }
        try {
          const rzpRefund = await rzp.client.payments.refund(payment.razorpay_payment_id, {
            amount: Math.round(refundAmount * 100),
            speed: 'normal',
            notes: { reason: note, order: payment.order_number, admin: String(adminId) },
          })
          refundId = rzpRefund.id
          destination = 'ORIGINAL_PAYMENT'
        } catch (err) {
          const msg = err?.error?.description || err?.message || 'Razorpay rejected the refund'
          throw { statusCode: 502, message: `Razorpay refund failed: ${msg}` }
        }
      }

      const totalRefunded = Math.round((alreadyRefunded + refundAmount) * 100) / 100
      const fully = totalRefunded >= paid
      const history = Array.isArray(payment.metadata?.refunds) ? payment.metadata.refunds : []
      history.push({ id: refundId, amount: refundAmount, reason: note, destination, by: adminId, at: new Date().toISOString() })
      await client.query(
        `UPDATE payments
            SET refund_id = $1, refund_amount = $2, refund_status = 'PROCESSED',
                status = CASE WHEN $3 THEN 'REFUNDED' ELSE status END,
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refunds', $4::jsonb),
                updated_at = NOW()
          WHERE id = $5`,
        [refundId, totalRefunded, fully, JSON.stringify(history), paymentId]
      )
      await client.query('COMMIT')
      result = { paymentId, refundId, refundAmount, totalRefunded, fullyRefunded: fully, destination, orderNumber: payment.order_number }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* already closed */ }
      throw err
    } finally {
      client.release()
    }

    logAdminActivity(adminId, `Refund ₹${result.refundAmount} (${result.destination}) on payment for order ${result.orderNumber}`,
      'order', orderId, null, { paymentId, refundId: result.refundId, refundAmount: result.refundAmount }, ip)
    return result
  }

  async updateStatus(orderId, newStatus, adminId, note, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const allowed = ALLOWED_TRANSITIONS[order.status]
    if (!allowed || !allowed.includes(newStatus)) {
      throw { statusCode: 400, message: `Cannot transition from ${order.status} to ${newStatus}` }
    }

    const oldStatus = await this.repository.updateStatus(orderId, newStatus, adminId, note)

    logAdminActivity(adminId, `Order status: ${oldStatus} → ${newStatus}`, 'order', orderId,
      { status: oldStatus }, { status: newStatus }, ip)

    // Fire background notification
    await notificationQueue.add('order-status-changed', {
      orderId, userId: order.user_id, riderId: order.rider_id,
      newStatus, orderNumber: order.order_number,
    })

    this._emitOrderStatus(order, newStatus)

    // AUTO-ASSIGN RIDER when order is CONFIRMED and no rider assigned yet
    if (ASSIGNABLE_ORDER_STATUSES.has(newStatus) && !order.rider_id) {
      try {
        await this._queueAutoAssign(orderId, `ADMIN_STATUS_${newStatus}`)
      } catch (err) {
        // Don't fail the status update — admin can still manually assign
        console.error('Auto-assign failed (non-blocking):', err.message)
      }
    }

    return { orderId, oldStatus, newStatus }
  }

  async assignRider(orderId, riderId, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const assignment = await this.repository.assignRider(orderId, riderId)

    logAdminActivity(adminId, `Assigned rider to order`, 'order', orderId,
      { rider_id: order.rider_id }, { rider_id: riderId }, ip)

    await notificationQueue.add('rider-assigned', {
      orderId, riderId, orderNumber: order.order_number,
    })

    this._emitAssignedOrder(order, riderId)

    return { orderId, riderId }
  }

  async bulkAssign(assignments, adminId, ip) {
    if (assignments.length > 50) throw { statusCode: 400, message: 'Max 50 assignments at once' }
    const results = await this.repository.bulkAssign(assignments)
    logAdminActivity(adminId, `Bulk assigned ${assignments.length} orders`, 'order', null, null,
      { count: assignments.length }, ip)

    for (const result of results) {
      await notificationQueue.add('rider-assigned', {
        orderId: result.orderId,
        riderId: result.riderId,
      })

      const order = await this.repository.findById(result.orderId)
      if (order) {
        this._emitAssignedOrder(order, result.riderId)
      }
    }

    return results
  }

  async createManualOrder(data, adminId, ip) {
    const order = await this.repository.createManualOrder({ ...data, adminId })
    logAdminActivity(adminId, `Created manual order ${order.order_number}`, 'order', order.id,
      null, { order_number: order.order_number, total: order.total_amount }, ip)
    if (!order.rider_id && ASSIGNABLE_ORDER_STATUSES.has(order.status)) {
      await this._queueAutoAssign(order.id, 'ADMIN_MANUAL_ORDER')
    }
    return order
  }

  async getInvoice(orderId) {
    // Same backend-issued, numbered invoice the customer sees.
    const file = await new InvoicesService().getPdfForAdmin(orderId)
    return file.buffer
  }

  async getPackingSlip(orderId) {
    const order = await this.findById(orderId)
    // Simplified packing slip — just items + customer info (no pricing)
    return {
      order_number: order.order_number, customer: order.customer_name,
      address: order.delivery_address, items: order.items.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit }))
    }
  }

  async exportCSV(filters) {
    const orders = await this.repository.getOrdersForExport(filters)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Orders')

    sheet.columns = [
      { header: 'Order Number', key: 'order_number', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total (₹)', key: 'total_amount', width: 12 },
      { header: 'Payment', key: 'payment_method', width: 12 },
      { header: 'Payment Status', key: 'payment_status', width: 15 },
      { header: 'Customer', key: 'customer', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'Date', key: 'created_at', width: 22 },
    ]

    orders.forEach(o => sheet.addRow(o))

    return workbook.csv.writeBuffer()
  }

  async refundOrder(orderId, { amount, reason, method }, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Only delivered or cancelled orders can be refunded
    if (!['DELIVERED', 'CANCELLED'].includes(order.status)) {
      throw { statusCode: 400, message: `Cannot refund an order with status ${order.status}` }
    }

    const refundAmount = amount || parseFloat(order.total_amount)

    // Credit wallet
    const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
    const customersRepo = new AdminCustomersRepository()
    await customersRepo.creditWallet(
      order.user_id,
      refundAmount,
      reason || `Refund for order ${order.order_number}`
    )

    // Update order status to REFUNDED
    const oldStatus = await this.repository.updateStatus(orderId, 'REFUNDED', adminId, reason || 'Refund issued')

    logAdminActivity(adminId, `Refund ₹${refundAmount} for order ${order.order_number}`, 'order', orderId,
      { status: oldStatus }, { status: 'REFUNDED', refundAmount }, ip)

    await notificationQueue.add('order-status-changed', {
      orderId, userId: order.user_id, riderId: order.rider_id,
      newStatus: 'REFUNDED', orderNumber: order.order_number,
    })

    return { orderId, refundAmount, status: 'REFUNDED' }
  }

  async cancelOrder(orderId, body, adminId, ip) {
    const { reason, refundTo } = body || {}
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Treat null status as PENDING
    const currentStatus = order.status || 'PENDING'
    const allowed = ALLOWED_TRANSITIONS[currentStatus]
    if (!allowed || !allowed.includes('CANCELLED')) {
      throw { statusCode: 400, message: `Cannot cancel an order with status ${currentStatus}` }
    }

    // Cancel the order
    const oldStatus = await this.repository.updateStatus(orderId, 'CANCELLED', adminId, reason || 'Cancelled by admin')

    // Handle refund to wallet if requested
    let refundAmount = 0
    if (refundTo === 'wallet') {
      refundAmount = parseFloat(order.total_amount)
      const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
      const customersRepo = new AdminCustomersRepository()
      await customersRepo.creditWallet(
        order.user_id,
        refundAmount,
        reason || `Refund for cancelled order ${order.order_number}`
      )
    }

    logAdminActivity(adminId, `Cancelled order ${order.order_number}${refundTo === 'wallet' ? ` (refunded ₹${refundAmount} to wallet)` : ''}`, 'order', orderId,
      { status: oldStatus }, { status: 'CANCELLED', refundTo, refundAmount }, ip)

    await notificationQueue.add('order-status-changed', {
      orderId, userId: order.user_id, riderId: order.rider_id,
      newStatus: 'CANCELLED', orderNumber: order.order_number,
    })

    return { orderId, status: 'CANCELLED', refundAmount, refundTo: refundTo || 'none' }
  }

  async bulkUpdateStatus(orderIds, newStatus, adminId, ip) {
    const results = []
    for (const orderId of orderIds) {
      try {
        const res = await this.updateStatus(orderId, newStatus, adminId, null, ip)
        results.push({ orderId, ...res, success: true })
      } catch (err) {
        results.push({ orderId, success: false, message: err.message || 'Failed' })
      }
    }
    return { updated: results.filter(r => r.success).length, results }
  }

  async _emitAssignedOrder(order, riderId) {
    try {
      if (!this.fastify?.emitOrderAssignedToRider) {
        return
      }

      // Get store location from app_settings (not hardcoded)
      let storeLat = 0, storeLng = 0
      let storeName = 'LNDRY Store', storeAddr = 'Pickup location', storePhone = ''
      try {
        const { rows } = await dbQuery(
          `SELECT key, value FROM app_settings WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
        )
        for (const row of rows) {
          const val = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : String(row.value)
          switch (row.key) {
            case 'store_lat': storeLat = parseFloat(val) || 0; break
            case 'store_lng': storeLng = parseFloat(val) || 0; break
            case 'store_name': storeName = val; break
            case 'store_address': storeAddr = val; break
            case 'store_phone': storePhone = val; break
          }
        }
      } catch (_) { /* use defaults if settings not found */ }

      const address = this._parseAddress(order.delivery_address)
      const riderEarning = parseFloat(order.delivery_fee || 25)
      this.fastify.emitOrderAssignedToRider(riderId, {
        orderId: order.id,
        orderNumber: order.order_number,
        status: 'ASSIGNED',
        totalAmount: parseFloat(order.total_amount || 0),
        paymentMethod: order.payment_method || 'ONLINE',
        estimatedDistance: 0,
        estimatedDuration: 0,
        riderEarning,
        offerTimeoutSeconds: 0,
        offerExpiresAt: null,
        isOfferActive: true,
        items: this._parseItems(order.items),
        customerAddress: {
          name: order.customer_name || address.name || 'Customer',
          address: address.address || address.fullAddress || 'Delivery address unavailable',
          landmark: address.landmark || '',
          phone: order.customer_phone || address.phone || '',
          lat: address.lat ?? address.latitude ?? 0,
          lng: address.lng ?? address.longitude ?? 0,
        },
        storeAddress: {
          name: storeName,
          address: storeAddr,
          landmark: '',
          phone: storePhone,
          lat: storeLat,
          lng: storeLng,
        },
      })
    } catch (_) {
      // Keep admin assignment non-blocking if realtime emit fails.
    }
  }

  /**
   * Keep admin flow aligned with worker-based auto-assign.
   */
  async _autoAssignRider(orderId, _order) {
    await this._queueAutoAssign(orderId, 'ADMIN_FALLBACK')
  }

  async _queueAutoAssign(orderId, source) {
    try {
      await orderQueue.add(
        'auto-assign',
        { type: 'auto-assign', orderId, source },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      console.warn('Auto-assign queue failed, running inline fallback:', err?.message || err)
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
    } catch (fallbackErr) {
      console.error('Inline auto-assign fallback failed:', fallbackErr?.message || fallbackErr)
    }
  }

  _emitOrderStatus(order, status) {
    try {
      if (!this.fastify?.emitOrderUpdate) {
        return
      }

      const userIds = [order.user_id, order.rider_id].filter(Boolean)
      this.fastify.emitOrderUpdate(order.id, userIds, {
        orderId: order.id,
        orderNumber: order.order_number,
        status,
        message: this._statusMessage(status),
      })
    } catch (_) {
      // Keep admin status updates non-blocking if realtime emit fails.
    }
  }

  _statusMessage(status) {
    const messages = {
      CANCELLED: 'Order cancelled by support',
      OUT_FOR_DELIVERY: 'Order is now out for delivery',
      DELIVERED: 'Order delivered successfully',
    }

    return messages[status] || `Order updated to ${status}`
  }

  _parseAddress(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return { address: value }
      }
    }
    return value
  }

  _parseItems(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return []
      }
    }
    return []
  }
}
