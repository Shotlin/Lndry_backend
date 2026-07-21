import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { ORDER_STATUSES, validateTransition, recordOrderEvent } from '../../utils/state-machine.js'
import { OrderOtpService } from '../order-otp/order-otp.service.js'
import { orderQueue } from '../../config/bullmq.js'

/**
 * Vendor Orders Service — handles vendor-side order lifecycle
 *
 * Business flows:
 * - Accept / Reject orders (with auto-reject timer cancellation)
 * - Processing stage transitions (WASHING → DRYING → IRONING → PACKED)
 * - Receipt reconciliation (garment count/weight adjustments with audit)
 * - Auto-assign pickup employees on VENDOR_ACCEPTED
 * - Auto-assign delivery employees on PACKED
 */
export class VendorOrdersService {
  constructor(options = {}) {
    this.otpService = options.otpService || new OrderOtpService()
  }

  /**
   * Resolve the vendor_id from the authenticated user (vendor owner or employee).
   */
  async _resolveVendorId(userId) {
    // Check if user is a vendor employee or owner
    const empRes = await query(
      `SELECT vendor_id, role FROM vendor_employees WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [userId]
    )
    if (empRes.rows.length > 0) return { vendorId: empRes.rows[0].vendor_id, role: empRes.rows[0].role }

    return null
  }

  /**
   * List orders for this vendor with filters
   */
  async listOrders(userId, filters = {}) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const { status, page = 1, limit = 20 } = filters
    const offset = (page - 1) * limit
    const params = [vendor.vendorId]
    const conditions = ['o.vendor_id = $1']
    let pIdx = 2

    if (status) {
      if (['WASHING', 'DRYING', 'IRONING'].includes(status)) {
        conditions.push(`o.status = 'PROCESSING'`)
        conditions.push(`o.processing_stage = $${pIdx++}`)
        params.push(status.charAt(0).toUpperCase() + status.slice(1).toLowerCase())
      } else {
        conditions.push(`o.status = $${pIdx++}`)
        params.push(status)
      }
    }

    const whereClause = conditions.join(' AND ')
    const listRes = await query(
      `SELECT o.id, o.order_number, o.status, o.user_id, o.items, o.subtotal,
              o.delivery_fee, o.platform_fee, o.tax_amount, o.total_amount,
              o.payment_method, o.payment_status,
              o.delivery_address, o.vendor_slot_id, o.pickup_date,
              o.estimated_amount_paise, o.payable_amount_paise, o.fee_breakdown,
              o.processing_stage, o.pickup_otp, o.delivery_otp,
              o.created_at, o.updated_at,
              u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
      [...params, limit, offset]
    )
    const countRes = await query(`SELECT COUNT(*)::int AS total FROM orders o WHERE ${whereClause}`, params)

    return {
      orders: listRes.rows,
      pagination: {
        page,
        limit,
        total: countRes.rows[0]?.total || 0,
        totalPages: Math.ceil((countRes.rows[0]?.total || 0) / limit)
      }
    }
  }

  /**
   * Get single order detail for vendor
   */
  async getOrder(userId, orderId) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const res = await query(
      `SELECT o.*,
              u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1 AND o.vendor_id = $2`,
      [orderId, vendor.vendorId]
    )
    const order = res.rows[0]
    if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

    // Fetch order lines
    const linesRes = await query(
      `SELECT ol.*, gt.name AS garment_type_name, gt.unit AS garment_unit
       FROM order_lines ol
       LEFT JOIN garment_types gt ON ol.garment_type_id = gt.id
       WHERE ol.order_id = $1`,
      [orderId]
    )
    order.lines = linesRes.rows

    // Fetch order events timeline
    const eventsRes = await query(
      `SELECT old_status, new_status, actor_role, note, timestamp
       FROM order_events
       WHERE order_id = $1
       ORDER BY timestamp ASC`,
      [orderId]
    )
    order.timeline = eventsRes.rows

    return order
  }

  /**
   * Vendor accepts the order → VENDOR_ACCEPTED
   * Side effects:
   *   - Cancels auto-reject BullMQ job
   *   - Auto-assigns pickup employee (lowest workload)
   *   - Generates pickup OTP
   */
  async acceptOrder(userId, orderId) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status, vendor_id, user_id FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      const transition = validateTransition(order.status, ORDER_STATUSES.VENDOR_ACCEPTED, vendor.role)
      if (!transition.valid) throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }

      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [ORDER_STATUSES.VENDOR_ACCEPTED, orderId]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: ORDER_STATUSES.VENDOR_ACCEPTED,
        actorId: userId,
        actorRole: vendor.role,
        note: 'Vendor accepted the order'
      })

      await client.query('COMMIT')

      // Cancel auto-reject BullMQ job (non-critical)
      try {
        const job = await orderQueue.getJob(`auto-reject-${orderId}`)
        if (job) await job.remove()
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Failed to cancel auto-reject job (non-critical)')
      }

      // Auto-assign pickup employee (non-critical, fire-and-forget)
      try {
        await this._autoAssignEmployee(orderId, vendor.vendorId, 'PICKUP')
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Auto-assign pickup employee failed (non-critical)')
      }

      // Generate pickup OTP
      try {
        await this.otpService.generateOtp(orderId, 'PICKUP')
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Pickup OTP generation failed (non-critical)')
      }

      return { orderId, status: ORDER_STATUSES.VENDOR_ACCEPTED }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Vendor rejects the order → VENDOR_REJECTED
   * Side effects:
   *   - Cancels auto-reject BullMQ job
   *   - Releases slot holds
   *   - Initiates refund via Razorpay
   */
  async rejectOrder(userId, orderId, reason) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status, vendor_id, user_id, vendor_slot_id, pickup_date FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      const transition = validateTransition(order.status, ORDER_STATUSES.VENDOR_REJECTED, vendor.role)
      if (!transition.valid) throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }

      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [ORDER_STATUSES.VENDOR_REJECTED, orderId]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: ORDER_STATUSES.VENDOR_REJECTED,
        actorId: userId,
        actorRole: vendor.role,
        note: reason || 'Vendor rejected the order'
      })

      // Release slot holds
      await client.query(
        `DELETE FROM slot_holds WHERE slot_id = $1 AND booking_date = $2::date`,
        [order.vendor_slot_id, order.pickup_date]
      )

      await client.query('COMMIT')

      // Cancel auto-reject job
      try {
        const job = await orderQueue.getJob(`auto-reject-${orderId}`)
        if (job) await job.remove()
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Failed to cancel auto-reject job after vendor rejection')
      }

      // Queue auto-refund (non-critical, fire-and-forget)
      try {
        await orderQueue.add('auto-refund', {
          type: 'auto-refund',
          orderId,
          reason: reason || 'Vendor rejected order'
        }, {
          jobId: `auto-refund-${orderId}`,
          removeOnComplete: true
        })
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Failed to queue auto-refund after vendor rejection')
      }

      return { orderId, status: ORDER_STATUSES.VENDOR_REJECTED }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Update order processing stage:
   *   RECEIVED_AT_VENDOR → WASHING → DRYING → IRONING → PACKED
   */
  async updateProcessingStage(userId, orderId, newStatus, deliveryOpts = {}) {
    const { deliverySlotLabel, deliverySlotAt } = deliveryOpts
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const allowedProcessingStatuses = [
      ORDER_STATUSES.RECEIVED_AT_VENDOR,
      'WASHING',
      'DRYING',
      'IRONING',
      ORDER_STATUSES.PACKED,
    ]
    if (!allowedProcessingStatuses.includes(newStatus)) {
      throw { statusCode: 400, message: 'Invalid processing stage', code: 'INVALID_STAGE' }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status, processing_stage, vendor_id FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      let currentLogicalStatus = order.status;
      if (order.status === 'PROCESSING' && order.processing_stage) {
        currentLogicalStatus = order.processing_stage.toUpperCase();
      }

      // Check transition logic using the logical stages
      // Note: state-machine.js was strictly aligned to DB schema, so it does not contain WASHING transitions anymore.
      // We will perform a granular check here for processing stages, then check the canonical transition.
      const isProcessingStage = ['WASHING', 'DRYING', 'IRONING'].includes(newStatus);
      const isCanonicalTransition = !isProcessingStage && currentLogicalStatus !== 'WASHING' && currentLogicalStatus !== 'DRYING' && currentLogicalStatus !== 'IRONING';
      
      if (isCanonicalTransition) {
        const transition = validateTransition(currentLogicalStatus, newStatus, vendor.role)
        if (!transition.valid) throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }
      } else {
        // Enforce processing stage sequential transitions
        const STAGE_ORDER = ['RECEIVED_AT_VENDOR', 'WASHING', 'DRYING', 'IRONING', 'PACKED'];
        const currIdx = STAGE_ORDER.indexOf(currentLogicalStatus);
        const nextIdx = STAGE_ORDER.indexOf(newStatus);
        if (currIdx === -1 || nextIdx === -1 || nextIdx <= currIdx) {
           throw { statusCode: 400, message: `Invalid state transition: Cannot go from ${currentLogicalStatus} to ${newStatus}`, code: 'INVALID_TRANSITION' }
        }
      }

      let dbStatus = newStatus;
      let dbStage = null;
      if (isProcessingStage) {
        dbStatus = 'PROCESSING';
        dbStage = newStatus.charAt(0).toUpperCase() + newStatus.slice(1).toLowerCase();
      } else if (newStatus === 'RECEIVED_AT_VENDOR') {
        dbStage = 'Received';
      } else if (newStatus === 'PACKED') {
        dbStage = 'Packed';
      }

      if (newStatus === 'PACKED' && (deliverySlotLabel || deliverySlotAt)) {
        await client.query(
          `UPDATE orders SET status = $1, processing_stage = $2, updated_at = NOW(),
                  vendor_delivery_slot_label = $3, vendor_delivery_slot_at = $4
           WHERE id = $5`,
          [dbStatus, dbStage, deliverySlotLabel || null, deliverySlotAt || null, orderId]
        )
      } else {
        await client.query(
          `UPDATE orders SET status = $1, processing_stage = $2, updated_at = NOW() WHERE id = $3`,
          [dbStatus, dbStage, orderId]
        )
      }

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus,
        actorId: userId,
        actorRole: vendor.role,
        note: `Processing stage updated to ${dbStage ?? newStatus}`
      })

      await client.query('COMMIT')

      // If PACKED, auto-assign delivery employee and generate delivery OTP
      if (newStatus === ORDER_STATUSES.PACKED) {
        try {
          await this._autoAssignEmployee(orderId, vendor.vendorId, 'DELIVERY')
        } catch (err) {
          logger.warn({ err: err.message, orderId }, 'Auto-assign delivery employee failed (non-critical)')
        }
        try {
          await this.otpService.generateOtp(orderId, 'DELIVERY')
        } catch (err) {
          logger.warn({ err: err.message, orderId }, 'Delivery OTP generation failed (non-critical)')
        }
      }

      return { orderId, status: newStatus, processing_stage: dbStage }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Receipt reconciliation — vendor updates actual garment count/weight
   * when garments are received at vendor (RECEIVED_AT_VENDOR or later).
   *
   * Recalculates final order amount using the stored pricing snapshot.
   * Creates an audit log of the adjustment.
   */
  async reconcileReceipt(userId, orderId, body) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const { confirmed_lines, confirmed_weight_kg, adjustment_reason } = body

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT o.id, o.status, o.vendor_id, o.estimated_amount_paise, o.payable_amount_paise,
                o.fee_breakdown, o.items
         FROM orders o
         WHERE o.id = $1 AND o.vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      // Only allow reconciliation when garments are at vendor
      const allowedStatuses = [
        ORDER_STATUSES.RECEIVED_AT_VENDOR,
        ORDER_STATUSES.PROCESSING,
        ORDER_STATUSES.PACKED,
      ]
      if (!allowedStatuses.includes(order.status)) {
        throw { statusCode: 400, message: 'Cannot reconcile receipt at this order stage', code: 'INVALID_STAGE' }
      }

      const feeBreakdown = typeof order.fee_breakdown === 'string'
        ? JSON.parse(order.fee_breakdown)
        : (order.fee_breakdown || {})
      const oldSubtotalPaise = feeBreakdown.subtotal_paise || order.estimated_amount_paise || 0

      // Fetch pricing snapshot from order lines to recalculate
      const linesRes = await client.query(
        `SELECT garment_type_id, rate_paise, estimated_quantity, confirmed_quantity
         FROM order_lines WHERE order_id = $1`,
        [orderId]
      )

      let newSubtotalPaise = 0

      if (confirmed_lines && confirmed_lines.length > 0) {
        for (const cline of confirmed_lines) {
          const existingLine = linesRes.rows.find(l => l.garment_type_id === cline.garment_type_id)
          if (!existingLine) continue

          const ratePaise = existingLine.rate_paise || 0
          const newTotal = ratePaise * cline.confirmed_quantity
          newSubtotalPaise += newTotal

          await client.query(
            `UPDATE order_lines
             SET confirmed_quantity = $1, total_paise = $2, total = ($2::numeric / 100), quantity = $1
             WHERE order_id = $3 AND garment_type_id = $4`,
            [cline.confirmed_quantity, newTotal, orderId, cline.garment_type_id]
          )
        }
      } else if (confirmed_weight_kg) {
        // Weight-based recalculation
        const weightLine = linesRes.rows.find(l => l.rate_paise > 0)
        if (weightLine) {
          newSubtotalPaise = Math.round(weightLine.rate_paise * confirmed_weight_kg)
          await client.query(
            `UPDATE order_lines
             SET confirmed_quantity = 1, total_paise = $1, total = ($1::numeric / 100)
             WHERE order_id = $2 AND garment_type_id = $3`,
            [newSubtotalPaise, orderId, weightLine.garment_type_id]
          )
        }
      } else {
        throw { statusCode: 400, message: 'Either confirmed_lines or confirmed_weight_kg required', code: 'INVALID_INPUT' }
      }

      // Recalculate totals
      const deliveryFeePaise = feeBreakdown.delivery_fee_paise || 2900
      const platformFeePaise = feeBreakdown.platform_fee_paise || 500
      const newPayableAmountPaise = newSubtotalPaise + deliveryFeePaise + platformFeePaise

      const newFeeBreakdown = {
        ...feeBreakdown,
        subtotal_paise: newSubtotalPaise,
        original_subtotal_paise: oldSubtotalPaise,
        adjustment_reason: adjustment_reason || 'Receipt reconciliation'
      }

      await client.query(
        `UPDATE orders
         SET estimated_amount_paise = $1, payable_amount_paise = $2,
             subtotal = ($1::numeric / 100), total_amount = ($2::numeric / 100),
             fee_breakdown = $3, updated_at = NOW()
         WHERE id = $4`,
        [newSubtotalPaise, newPayableAmountPaise, JSON.stringify(newFeeBreakdown), orderId]
      )

      // Audit log
      await client.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor_id, actor_role, old_data, new_data, note)
         VALUES ('ORDER', $1, 'RECEIPT_RECONCILIATION', $2, $3, $4, $5, $6)`,
        [
          orderId,
          userId,
          vendor.role,
          JSON.stringify({ subtotal_paise: oldSubtotalPaise }),
          JSON.stringify({ subtotal_paise: newSubtotalPaise, confirmed_weight_kg }),
          adjustment_reason || 'Receipt reconciliation'
        ]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: order.status, // Status doesn't change
        actorId: userId,
        actorRole: vendor.role,
        note: `Receipt reconciled: subtotal changed from ${oldSubtotalPaise} to ${newSubtotalPaise} paise. Reason: ${adjustment_reason || 'N/A'}`
      })

      await client.query('COMMIT')

      return {
        orderId,
        old_subtotal_paise: oldSubtotalPaise,
        new_subtotal_paise: newSubtotalPaise,
        new_payable_amount_paise: newPayableAmountPaise,
        adjustment_reason
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Auto-assign an employee from the same vendor with the lowest active jobs count.
   * Purpose: 'PICKUP' or 'DELIVERY'
   */
  async _autoAssignEmployee(orderId, vendorId, purpose) {
    const assignmentType = purpose === 'PICKUP' ? 'PICKUP_ASSIGNED' : 'DELIVERY_ASSIGNED'

    // Find the vendor employee with the fewest active assignments. Prefer
    // a dedicated VENDOR_RIDER; fall back to any VENDOR_STAFF so vendors
    // who haven't configured a rider yet keep today's assignment behavior.
    const employeeQuery = (role) => query(
      `SELECT ve.user_id, ve.id AS employee_id, u.name AS full_name,
              COALESCE((
                SELECT COUNT(*)::int FROM order_assignments oa
                WHERE oa.employee_id = ve.user_id
                  AND oa.status IN ('ASSIGNED', 'IN_TRANSIT')
              ), 0) AS active_jobs
       FROM vendor_employees ve
       JOIN users u ON ve.user_id = u.id
       WHERE ve.vendor_id = $1
         AND ve.is_active = true
         AND ve.role = $2
       ORDER BY active_jobs ASC, ve.created_at ASC
       LIMIT 1`,
      [vendorId, role]
    )

    let empRes = await employeeQuery('VENDOR_RIDER')
    if (empRes.rows.length === 0) {
      empRes = await employeeQuery('VENDOR_STAFF')
    }

    if (empRes.rows.length === 0) {
      logger.info({ orderId, vendorId, purpose }, 'No available employees for auto-assignment')
      return null
    }

    const employee = empRes.rows[0]

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Lock the order
      const { rows } = await client.query(
        `SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      )
      const order = rows[0]
      if (!order) {
        await client.query('ROLLBACK')
        return null
      }

      const transition = validateTransition(order.status, assignmentType, 'SYSTEM')
      if (!transition.valid) {
        logger.info({ orderId, currentStatus: order.status, target: assignmentType }, 'Skipping auto-assign: invalid transition')
        await client.query('ROLLBACK')
        return null
      }

      // Create assignment record. rider_id is a NOT NULL legacy column
      // (from the platform-wide gig-rider system, pre-dating employee_id) —
      // must still be populated or this insert violates the constraint.
      // For a vendor-owned assignee, employee_id and rider_id are the same
      // person, so we just mirror the value.
      await client.query(
        `INSERT INTO order_assignments (order_id, employee_id, rider_id, assignment_type, status, vendor_id)
         VALUES ($1, $2, $2, $3, 'ASSIGNED', $4)
         ON CONFLICT (order_id, assignment_type) DO UPDATE SET
           employee_id = EXCLUDED.employee_id,
           rider_id = EXCLUDED.rider_id,
           status = 'ASSIGNED',
           assigned_at = NOW()`,
        [orderId, employee.user_id, purpose, vendorId]
      )

      // Update order status
      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [assignmentType, orderId]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: assignmentType,
        actorId: null,
        actorRole: 'SYSTEM',
        note: `Auto-assigned ${purpose.toLowerCase()} to employee ${employee.full_name}`
      })

      await client.query('COMMIT')

      logger.info({
        orderId,
        employeeId: employee.user_id,
        employeeName: employee.full_name,
        purpose,
        activeJobs: employee.active_jobs
      }, `Auto-assigned ${purpose.toLowerCase()} employee`)

      return employee
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Get vendor dashboard stats
   */
  async getDashboardStats(userId) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const statsRes = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'WAITING_VENDOR_CONFIRMATION')::int AS pending_orders,
         COUNT(*) FILTER (WHERE status = 'VENDOR_ACCEPTED')::int AS accepted_orders,
         COUNT(*) FILTER (WHERE status IN ('RECEIVED_AT_VENDOR', 'PROCESSING'))::int AS processing_orders,
         COUNT(*) FILTER (WHERE status = 'PACKED')::int AS packed_orders,
         COUNT(*) FILTER (WHERE status IN ('DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY'))::int AS delivery_orders,
         COUNT(*) FILTER (WHERE status = 'DELIVERED' AND created_at >= CURRENT_DATE)::int AS delivered_today,
         COALESCE(SUM(payable_amount_paise) FILTER (WHERE status = 'DELIVERED' AND created_at >= CURRENT_DATE), 0)::bigint AS revenue_today_paise
       FROM orders
       WHERE vendor_id = $1`,
      [vendor.vendorId]
    )

    return statsRes.rows[0]
  }
}
