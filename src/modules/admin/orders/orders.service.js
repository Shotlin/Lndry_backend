import { notificationQueue, orderQueue } from '../../../config/bullmq.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { generateInvoicePDF } from '../../../utils/invoiceGenerator.js'
import { query as dbQuery } from '../../../config/database.js'
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
    const [order, items, timeline, payment, delivery] = await Promise.all([
      this.repository.findById(orderId),
      this.repository.getOrderItems(orderId),
      this.repository.getOrderTimeline(orderId),
      this.repository.getOrderPayment(orderId),
      this.repository.getOrderDelivery(orderId),
    ])
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    return { ...order, items, timeline, payment, delivery }
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
    const order = await this.findById(orderId)
    return generateInvoicePDF(order)
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
