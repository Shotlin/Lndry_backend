import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { ORDER_STATUSES, validateTransition, recordOrderEvent } from '../../utils/state-machine.js'
import { OrderOtpService } from '../order-otp/order-otp.service.js'
import { orderQueue } from '../../config/bullmq.js'
import { computeRecalculatedTotals } from '../../utils/order-recalculation.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'

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
  constructor({ fastify, otpService } = {}) {
    this.fastify = fastify || null
    this.otpService = otpService || new OrderOtpService()
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
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
              o.delivery_fee, o.platform_fee, o.tax_amount, o.handling_fee, o.total_amount,
              o.payment_method, o.payment_status,
              o.delivery_address, o.vendor_slot_id, o.pickup_date,
              o.estimated_amount_paise, o.payable_amount_paise, o.fee_breakdown,
              o.processing_stage, o.pickup_otp, o.delivery_otp,
              o.created_at, o.updated_at,
              u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE ${whereClause}
       ORDER BY o.updated_at DESC
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
              u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
              r.vendor_rating, r.rider_rating AS delivery_rating, r.comment AS review_comment
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       LEFT JOIN reviews r ON r.order_id = o.id AND r.deleted_at IS NULL
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

    const paidRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS amount_paid FROM payments WHERE order_id = $1 AND status = 'PAID'`,
      [orderId]
    )
    order.amountPaidPaise = Math.round(Number(paidRes.rows[0].amount_paid) * 100)

    const reconRes = await query(
      `SELECT * FROM order_reconciliations WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    )
    if (reconRes.rows[0]) {
      // Photos aren't on order_reconciliations itself — attached here so the
      // vendor's own order-detail screen can keep showing exactly what was
      // submitted (services, quantities, amount, reason, evidence) while a
      // proposal is pending/disputed, instead of reverting to stale
      // pre-reconciliation data.
      const photosRes = await query(
        `SELECT photo_url FROM order_pickup_photos WHERE order_reconciliation_id = $1 ORDER BY created_at ASC`,
        [reconRes.rows[0].id]
      )
      order.latestReconciliation = { ...reconRes.rows[0], photos: photosRes.rows.map((r) => r.photo_url) }
    } else {
      order.latestReconciliation = null
    }

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
   * Vendor's authoritative recalculation — supersedes the rider's rough
   * doorstep correction with a garment-expert re-verification, backed by
   * required photo evidence. Unlike the rider's step, this NEVER applies
   * immediately: it stages a proposal and pauses the order at
   * RECONCILIATION_PENDING until the customer explicitly accepts or rejects
   * it (see OrdersService.acceptReconciliation/rejectReconciliation).
   */
  async proposeReconciliation(userId, orderId, body) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const {
      lines: confirmedLines,
      confirmed_weight_kg: confirmedWeightKg,
      adjustment_reason: adjustmentReason,
      photo_urls: photoUrls,
      new_lines: requestedNewLines,
    } = body

    if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
      throw { statusCode: 400, message: 'At least one photo_urls entry is required', code: 'VALIDATION_ERROR' }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status, user_id, vendor_id, fee_breakdown, estimated_amount_paise, payable_amount_paise
         FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      // This correction must happen before washing starts — either right
      // after receiving items, or again after a customer rejection + support call.
      const allowedStatuses = [ORDER_STATUSES.RECEIVED_AT_VENDOR, ORDER_STATUSES.RECONCILIATION_DISPUTED]
      if (!allowedStatuses.includes(order.status)) {
        throw { statusCode: 400, message: 'Cannot propose a reconciliation at this order stage', code: 'INVALID_STAGE' }
      }

      const transition = validateTransition(order.status, ORDER_STATUSES.RECONCILIATION_PENDING, vendor.role)
      if (!transition.valid) throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }

      const linesRes = await client.query(
        `SELECT id, garment_type_id, name, unit, rate_paise, estimated_quantity, confirmed_quantity
         FROM order_lines WHERE order_id = $1`,
        [orderId]
      )
      const linesById = new Map(linesRes.rows.map((l) => [l.id, l]))

      // Reclassification (100% of an existing line moves to a different
      // service, e.g. a delicate item selected under a per-kg wash actually
      // needs a per-piece dry-clean service) and new lines (a service that
      // wasn't on the order at all — either a genuine addition, or the
      // destination for a *partial* quantity moved out of an existing
      // continuous-unit line, which the vendor achieves by reducing that
      // line's confirmed_weight_kg and adding the moved garments here).
      // Both resolve requested garment_type_ids against THIS vendor's own
      // active, approved rates in one batched query — never trust a
      // client-supplied rate_paise directly.
      const requestedReclassifications = (confirmedLines || []).filter((l) => l.new_garment_type_id)
      const requestedNewLinesArr = (requestedNewLines || []).filter((l) => l.garment_type_id && l.quantity > 0)
      const requestedGarmentTypeIds = [...new Set([
        ...requestedReclassifications.map((l) => l.new_garment_type_id),
        ...requestedNewLinesArr.map((l) => l.garment_type_id),
      ])]

      const reclassifications = new Map()
      const newLines = []
      if (requestedGarmentTypeIds.length > 0) {
        const ratesRes = await client.query(
          `SELECT vsr.rate_paise, gt.id AS garment_type_id, gt.name, gt.unit
           FROM vendor_service_rates vsr
           JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
           JOIN garment_types gt ON vsr.garment_type_id = gt.id
           WHERE vs.vendor_id = $1 AND vsr.garment_type_id = ANY($2::uuid[])
             AND vsr.is_active = true AND vs.deleted_at IS NULL AND vs.approval_status = 'APPROVED' AND gt.is_active = true`,
          [vendor.vendorId, requestedGarmentTypeIds]
        )
        const rateByGarmentTypeId = new Map(ratesRes.rows.map((r) => [r.garment_type_id, r]))

        for (const line of requestedReclassifications) {
          if (!linesById.has(line.order_line_id)) {
            throw { statusCode: 400, message: `Unknown order_line_id: ${line.order_line_id}`, code: 'VALIDATION_ERROR' }
          }
          const rate = rateByGarmentTypeId.get(line.new_garment_type_id)
          if (!rate) {
            throw { statusCode: 400, message: 'One or more selected services are not available for this vendor', code: 'SERVICE_NOT_AVAILABLE' }
          }
          reclassifications.set(line.order_line_id, {
            garmentTypeId: rate.garment_type_id,
            name: rate.name,
            unit: rate.unit,
            ratePaise: rate.rate_paise,
          })
        }

        for (const line of requestedNewLinesArr) {
          const rate = rateByGarmentTypeId.get(line.garment_type_id)
          if (!rate) {
            throw { statusCode: 400, message: 'One or more selected services are not available for this vendor', code: 'SERVICE_NOT_AVAILABLE' }
          }
          newLines.push({
            garmentTypeId: rate.garment_type_id,
            name: rate.name,
            unit: rate.unit,
            ratePaise: rate.rate_paise,
            quantity: line.quantity,
          })
        }
      }

      const computed = computeRecalculatedTotals({
        orderRow: order,
        lines: linesRes.rows,
        confirmedLines,
        confirmedWeightKg,
        reclassifications,
        newLines,
      })

      let reconciliationId
      try {
        const reconRes = await client.query(
          `INSERT INTO order_reconciliations (
             order_id, stage, status, proposed_by, proposed_by_role,
             previous_subtotal_paise, proposed_subtotal_paise,
             previous_payable_amount_paise, proposed_payable_amount_paise,
             previous_weight_kg, proposed_weight_kg, line_changes, reason
           ) VALUES ($1, 'VENDOR_RECEIPT', 'PENDING_CUSTOMER', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            orderId, userId, vendor.role,
            computed.previousSubtotalPaise, computed.proposedSubtotalPaise,
            computed.previousPayableAmountPaise, computed.proposedPayableAmountPaise,
            computed.previousWeightKg, computed.proposedWeightKg,
            JSON.stringify(computed.lineChanges), adjustmentReason || null,
          ]
        )
        reconciliationId = reconRes.rows[0].id
      } catch (err) {
        if (err.code === '23505') {
          throw { statusCode: 409, message: 'A reconciliation is already awaiting customer approval for this order', code: 'RECONCILIATION_ALREADY_PENDING' }
        }
        throw err
      }

      for (const url of photoUrls) {
        await client.query(
          `INSERT INTO order_pickup_photos (order_id, photo_url, is_grouped, uploaded_by, context, order_reconciliation_id)
           VALUES ($1, $2, true, $3, 'VENDOR_RECONCILIATION', $4)`,
          [orderId, url, userId, reconciliationId]
        )
      }

      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [ORDER_STATUSES.RECONCILIATION_PENDING, orderId]
      )

      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_role, actor_shop_id, target_type, target_id, action, before, after)
         VALUES ($1, $2, $3, 'ORDER', $4, 'RECEIPT_RECONCILIATION_PROPOSED', $5, $6)`,
        [
          userId, vendor.role, vendor.vendorId, orderId,
          JSON.stringify({ subtotal_paise: computed.previousSubtotalPaise }),
          JSON.stringify({ subtotal_paise: computed.proposedSubtotalPaise, confirmed_weight_kg: confirmedWeightKg }),
        ]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: ORDER_STATUSES.RECONCILIATION_PENDING,
        actorId: userId,
        actorRole: vendor.role,
        note: `Vendor proposed subtotal change from ${computed.previousSubtotalPaise} to ${computed.proposedSubtotalPaise} paise. Reason: ${adjustmentReason || 'N/A'}`
      })

      await client.query('COMMIT')

      if (this.notificationsService && order.user_id) {
        try {
          await this.notificationsService.sendNotification(order.user_id, {
            title: 'Your order total was updated',
            body: 'The vendor found a difference after weighing your items. Review the new total in the app.',
            type: 'order_reconciliation_proposed',
            data: { orderId, reconciliationId },
          })
        } catch (err) {
          logger.warn({ err: err.message, orderId }, 'Failed to notify customer of reconciliation proposal (non-critical)')
        }
      }

      return {
        orderId,
        status: ORDER_STATUSES.RECONCILIATION_PENDING,
        reconciliation_id: reconciliationId,
        previous_payable_amount_paise: computed.previousPayableAmountPaise,
        proposed_payable_amount_paise: computed.proposedPayableAmountPaise,
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
