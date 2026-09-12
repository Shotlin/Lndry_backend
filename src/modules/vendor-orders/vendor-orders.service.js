import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { ORDER_STATUSES, validateTransition, recordOrderEvent } from '../../utils/state-machine.js'
import { OrderOtpService } from '../order-otp/order-otp.service.js'
import { orderQueue } from '../../config/bullmq.js'
import { computeRecalculatedTotals } from '../../utils/order-recalculation.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { emitJobOfferedToRiders } from '../../plugins/socketio.plugin.js'
import { RiderAssignmentSettingsService } from '../rider-assignment-settings/rider-assignment-settings.service.js'

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

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
    this.feeSettingsService = new FeeSettingsService()
    this.riderAssignmentSettingsService = new RiderAssignmentSettingsService()
  }

  /**
   * Compute what the vendor actually earns from an order: their service
   * subtotal plus the delivery fee (the vendor runs their own delivery, so
   * they keep all of it — unlike platform fee/GST/handling fee, which are
   * LNDRY/customer-side charges the vendor never sees), minus LNDRY's
   * commission and, if enabled, GST on that commission — mirroring how
   * Zomato/Swiggy show restaurant-partner earnings (commission computed on
   * order value only, GST charged on top of the commission itself).
   *
   * This is a LIVE estimate computed from the vendor's current effective
   * fee_settings (global or a per-shop override) — not a locked settlement
   * snapshot. `vendor_commission_*` is a reference-only config (see the
   * Fees admin page); it is not yet wired into shop-financials/
   * settlement.service.js, so this figure is informational for the vendor,
   * not an authoritative payout record.
   *
   * @private
   * @param {object|object[]} orders - order row(s) with subtotal/delivery_fee
   * @param {string} vendorId
   */
  async _attachVendorEarnings(orders, vendorId) {
    const { config } = await this.feeSettingsService.resolveForShop(vendorId)
    const list = Array.isArray(orders) ? orders : [orders]

    for (const order of list) {
      const subtotal = Number(order.subtotal) || 0
      const deliveryFee = Number(order.delivery_fee) || 0

      let commissionAmount = 0
      if (config.vendor_commission_enabled) {
        commissionAmount =
          config.vendor_commission_type === 'PERCENT'
            ? (subtotal * Number(config.vendor_commission_value)) / 100
            : Number(config.vendor_commission_value)
      }
      const gstOnCommission = config.gst_enabled
        ? (commissionAmount * Number(config.gst_rate)) / 100
        : 0

      order.vendor_commission_enabled = !!config.vendor_commission_enabled
      order.vendor_commission_type = config.vendor_commission_type
      order.vendor_commission_rate = Number(config.vendor_commission_value)
      order.vendor_commission_amount = round2(commissionAmount)
      order.vendor_gst_on_commission_enabled = !!config.gst_enabled
      order.vendor_gst_rate = Number(config.gst_rate)
      order.vendor_gst_on_commission_amount = round2(gstOnCommission)
      order.vendor_payout_amount = round2(subtotal + deliveryFee - commissionAmount - gstOnCommission)
    }

    return orders
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

    await this._attachVendorEarnings(listRes.rows, vendor.vendorId)

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

    const assignmentsRes = await query(
      `SELECT oa.assignment_type, oa.status, oa.is_broadcast_offer, oa.offer_expires_at,
              u2.name AS rider_name, u2.phone AS rider_phone
       FROM order_assignments oa
       LEFT JOIN users u2 ON u2.id = oa.employee_id
       WHERE oa.order_id = $1`,
      [orderId]
    )
    order.pickupAssignment = null
    order.deliveryAssignment = null
    for (const row of assignmentsRes.rows) {
      const value = {
        riderName: row.rider_name,
        riderPhone: row.rider_phone,
        status: row.status,
        isBroadcastOffer: row.is_broadcast_offer,
        offerExpiresAt: row.offer_expires_at,
      }
      if (row.assignment_type === 'PICKUP') order.pickupAssignment = value
      else if (row.assignment_type === 'DELIVERY') order.deliveryAssignment = value
    }

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

    await this._attachVendorEarnings(order, vendor.vendorId)

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
   * Find the vendor employee with the fewest active (ASSIGNED/IN_TRANSIT)
   * assignments right now. Prefers a dedicated VENDOR_RIDER; falls back to
   * any VENDOR_STAFF so vendors who haven't configured a rider yet keep
   * today's assignment behavior. Shared by _autoAssignEmployee (new order
   * needs a first assignee) and reassignOrphanedAssignments (an existing
   * assignment's assignee went inactive and needs a replacement) so both
   * always agree on who's "next up".
   * @private
   */
  async _pickLeastBusyEmployee(vendorId) {
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

    return empRes.rows[0] || null
  }

  /**
   * Auto-assign an employee from the same vendor with the lowest active jobs count.
   * Purpose: 'PICKUP' or 'DELIVERY'
   */
  async _autoAssignEmployee(orderId, vendorId, purpose) {
    const assignmentType = purpose === 'PICKUP' ? 'PICKUP_ASSIGNED' : 'DELIVERY_ASSIGNED'

    const employee = await this._pickLeastBusyEmployee(vendorId)
    if (!employee) {
      logger.info({ orderId, vendorId, purpose }, 'No available employees for auto-assignment')
      return null
    }

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
   * Retry pickup auto-assignment for this vendor's orders stuck at
   * VENDOR_ACCEPTED with nobody assigned — this happens when the vendor
   * accepts an order before adding any rider/staff, since acceptOrder's
   * call to _autoAssignEmployee silently no-ops when the employee query
   * comes back empty (see the 'No available employees for auto-assignment'
   * log line above) and nothing ever retries it. Without this, such an
   * order stays invisible to every rider forever, even ones added later.
   * Called from vendor-employees.service.js whenever a rider becomes
   * available (created, attached from an existing account, or
   * reactivated) so the backlog clears itself instead of needing a
   * manual fix.
   */
  async backfillPickupAssignments(vendorId) {
    const { rows } = await query(
      `SELECT id FROM orders WHERE vendor_id = $1 AND status = 'VENDOR_ACCEPTED' ORDER BY created_at ASC`,
      [vendorId]
    )

    const assignedOrderIds = []
    for (const row of rows) {
      try {
        const employee = await this._autoAssignEmployee(row.id, vendorId, 'PICKUP')
        if (employee) assignedOrderIds.push(row.id)
        else break // no employee available (or became unavailable mid-loop) — stop trying the rest
      } catch (err) {
        logger.warn({ err: err.message, orderId: row.id, vendorId }, 'Backfill pickup auto-assign failed (non-critical)')
      }
    }
    return assignedOrderIds
  }

  /**
   * Reassign any order_assignments row still pointing at a rider/staff who
   * is no longer active at this vendor (deactivated, removed, or replaced
   * by a different phone number) to whoever has the fewest active jobs
   * among the vendor's currently-active riders/staff, if anyone.
   *
   * This is the mirror case to backfillPickupAssignments: that one covers
   * an order that never got assigned in the first place (still sitting at
   * VENDOR_ACCEPTED); this one covers an order that WAS assigned and then
   * its assignee went inactive — the order_assignments row itself never
   * changes on deactivation, so it silently keeps pointing at someone who
   * can no longer even list their own jobs (VendorRiderService#listJobs
   * requires is_active = true just to log in), while every other rider's
   * job list only ever matches rows where employee_id is their own
   * user_id. Without this, such an order is invisible to everyone forever,
   * even a brand-new rider added specifically to replace the old one.
   *
   * Only the assignee (employee_id/rider_id) changes — the order's own
   * status is left untouched, since the pickup/delivery stage itself
   * hasn't changed, only who is doing it.
   *
   * Called from vendor-employees.service.js whenever a rider/staff's
   * active state changes in either direction: someone going inactive
   * hands off whatever they were holding right now (instead of leaving it
   * stranded until some future roster change happens to trigger a
   * resync), and someone becoming active picks up anything still left
   * orphaned from an earlier deactivation.
   */
  async reassignOrphanedAssignments(vendorId) {
    const { rows: orphaned } = await query(
      `SELECT oa.id, oa.order_id
       FROM order_assignments oa
       WHERE oa.vendor_id = $1
         AND oa.status IN ('ASSIGNED', 'IN_TRANSIT')
         AND NOT EXISTS (
           SELECT 1 FROM vendor_employees ve
           WHERE ve.user_id = oa.employee_id
             AND ve.vendor_id = $1
             AND ve.is_active = true
         )
       ORDER BY oa.assigned_at ASC`,
      [vendorId]
    )

    const reassignedOrderIds = []
    for (const row of orphaned) {
      try {
        const employee = await this._pickLeastBusyEmployee(vendorId)
        if (!employee) break // nobody active at all — stop, nothing else will succeed either

        await query(
          `UPDATE order_assignments SET employee_id = $1, rider_id = $1, updated_at = NOW() WHERE id = $2`,
          [employee.user_id, row.id]
        )
        reassignedOrderIds.push(row.order_id)
      } catch (err) {
        logger.warn({ err: err.message, assignmentId: row.id, vendorId }, 'Reassign orphaned assignment failed (non-critical)')
      }
    }
    return reassignedOrderIds
  }

  /**
   * Manually assign (or reassign) a specific rider/staff to an order — the
   * vendor picking someone by name, instead of the system auto-picking
   * whoever is least busy. Phase 1 of the rider-assignment initiative (see
   * CLAUDE.md "Rider Assignment: Broadcast + Timeout Reassignment System").
   *
   * Two cases, matched by the order's current status:
   *   - No assignment yet (VENDOR_ACCEPTED for pickup, PACKED for delivery)
   *     → creates the assignment AND advances the order status, exactly
   *     like _autoAssignEmployee.
   *   - Already assigned, work not yet done (PICKUP_ASSIGNED/
   *     GOING_FOR_PICKUP/PICKUP_OTP_VERIFIED, or DELIVERY_ASSIGNED/
   *     OUT_FOR_DELIVERY) → swaps just the assignee, order status
   *     untouched — mirrors reassignOrphanedAssignments (the stage hasn't
   *     changed, only who's doing it).
   *
   * @param {string} userId - authenticated caller (vendor owner/staff)
   * @param {string} orderId
   * @param {string} vendorEmployeeId - vendor_employees.id (the staff
   *        record id the vendor app's roster list exposes as `id` — NOT
   *        users.id, which is what order_assignments.employee_id actually
   *        stores; resolved below).
   */
  async assignSpecificEmployee(userId, orderId, vendorEmployeeId) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const empRes = await query(
      `SELECT ve.user_id, ve.id AS employee_id, u.name AS full_name
       FROM vendor_employees ve
       JOIN users u ON ve.user_id = u.id
       WHERE ve.id = $1 AND ve.vendor_id = $2 AND ve.is_active = true
         AND ve.role IN ('VENDOR_RIDER', 'VENDOR_STAFF')`,
      [vendorEmployeeId, vendor.vendorId]
    )
    const employee = empRes.rows[0]
    if (!employee) {
      throw { statusCode: 404, message: 'Rider/staff not found or inactive', code: 'EMPLOYEE_NOT_FOUND' }
    }

    const PICKUP_STAGE_STATUSES = ['VENDOR_ACCEPTED', 'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED']
    const DELIVERY_STAGE_STATUSES = ['PACKED', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY']

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) {
        await client.query('ROLLBACK')
        throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
      }

      let purpose
      if (PICKUP_STAGE_STATUSES.includes(order.status)) purpose = 'PICKUP'
      else if (DELIVERY_STAGE_STATUSES.includes(order.status)) purpose = 'DELIVERY'
      else {
        await client.query('ROLLBACK')
        throw {
          statusCode: 400,
          message: `Order is not at a stage that can be assigned right now (currently ${order.status})`,
          code: 'INVALID_TRANSITION',
        }
      }

      const needsFirstAssignment = order.status === 'VENDOR_ACCEPTED' || order.status === 'PACKED'
      const assignmentType = purpose === 'PICKUP' ? 'PICKUP_ASSIGNED' : 'DELIVERY_ASSIGNED'

      if (needsFirstAssignment) {
        const transition = validateTransition(order.status, assignmentType, vendor.role)
        if (!transition.valid) {
          await client.query('ROLLBACK')
          throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }
        }

        await client.query(
          `INSERT INTO order_assignments (order_id, employee_id, rider_id, assignment_type, status, vendor_id, is_broadcast_offer, offer_expires_at)
           VALUES ($1, $2, $2, $3, 'ASSIGNED', $4, false, NULL)
           ON CONFLICT (order_id, assignment_type) DO UPDATE SET
             employee_id = EXCLUDED.employee_id,
             rider_id = EXCLUDED.rider_id,
             status = 'ASSIGNED',
             is_broadcast_offer = false,
             offer_expires_at = NULL,
             assigned_at = NOW()`,
          [orderId, employee.user_id, purpose, vendor.vendorId]
        )
        await client.query(
          `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
          [assignmentType, orderId]
        )
      } else {
        // A direct assign always wins and always results in a clean,
        // confirmed ASSIGNED state — regardless of whatever the row's
        // prior status was (a previously assigned rider, or a pending
        // broadcast/offer). Previously this only updated employee_id/
        // rider_id and left `status` untouched, so reassigning over a
        // still-OFFERED broadcast silently produced a row pointed at the
        // right rider but still stuck OFFERED — invisible to that
        // rider's job list, which only shows ASSIGNED/IN_TRANSIT.
        await client.query(
          `UPDATE order_assignments SET employee_id = $1, rider_id = $1, status = 'ASSIGNED',
             is_broadcast_offer = false, offer_expires_at = NULL, updated_at = NOW()
           WHERE order_id = $2 AND assignment_type = $3`,
          [employee.user_id, orderId, purpose]
        )
      }

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: needsFirstAssignment ? assignmentType : order.status,
        actorId: userId,
        actorRole: vendor.role,
        note: `Manually ${needsFirstAssignment ? 'assigned' : 'reassigned'} ${purpose.toLowerCase()} to ${employee.full_name}`,
      })

      await client.query('COMMIT')

      return {
        orderId,
        employeeId: employee.employee_id,
        employeeName: employee.full_name,
        purpose,
        status: needsFirstAssignment ? assignmentType : order.status,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Offer (rather than directly assign) a specific rider/staff — creates
   * an OFFERED order_assignments row the rider must explicitly accept
   * (VendorRiderService#acceptOffer) before it becomes their confirmed
   * job. Phase 2 of the rider-assignment initiative (see CLAUDE.md) — the
   * single-target counterpart to what Phase 3's broadcast will do for
   * multiple riders at once.
   *
   * Unlike assignSpecificEmployee (Phase 1, direct + final), offering
   * does NOT change the order's own status — that only happens on
   * accept, so an unaccepted offer never falsely claims a pipeline stage
   * nobody is actually working on.
   *
   * @param {string} userId - authenticated caller (vendor owner/staff)
   * @param {string} orderId
   * @param {string} vendorEmployeeId - vendor_employees.id
   */
  async offerToEmployee(userId, orderId, vendorEmployeeId) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const empRes = await query(
      `SELECT ve.user_id, ve.id AS employee_id, u.name AS full_name
       FROM vendor_employees ve
       JOIN users u ON ve.user_id = u.id
       WHERE ve.id = $1 AND ve.vendor_id = $2 AND ve.is_active = true
         AND ve.role IN ('VENDOR_RIDER', 'VENDOR_STAFF')`,
      [vendorEmployeeId, vendor.vendorId]
    )
    const employee = empRes.rows[0]
    if (!employee) {
      throw { statusCode: 404, message: 'Rider/staff not found or inactive', code: 'EMPLOYEE_NOT_FOUND' }
    }

    const PICKUP_STAGE_STATUSES = ['VENDOR_ACCEPTED', 'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED']
    const DELIVERY_STAGE_STATUSES = ['PACKED', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY']

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE`,
        [orderId, vendor.vendorId]
      )
      const order = rows[0]
      if (!order) {
        await client.query('ROLLBACK')
        throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
      }

      let purpose
      if (PICKUP_STAGE_STATUSES.includes(order.status)) purpose = 'PICKUP'
      else if (DELIVERY_STAGE_STATUSES.includes(order.status)) purpose = 'DELIVERY'
      else {
        await client.query('ROLLBACK')
        throw {
          statusCode: 400,
          message: `Order is not at a stage that can be offered right now (currently ${order.status})`,
          code: 'INVALID_TRANSITION',
        }
      }

      const existing = await client.query(
        `SELECT status FROM order_assignments WHERE order_id = $1 AND assignment_type = $2 FOR UPDATE`,
        [orderId, purpose]
      )
      if (existing.rows[0] && ['ASSIGNED', 'IN_TRANSIT'].includes(existing.rows[0].status)) {
        await client.query('ROLLBACK')
        throw {
          statusCode: 409,
          message: 'This order already has a confirmed rider — reassign it directly instead of offering',
          code: 'ALREADY_ASSIGNED',
        }
      }

      await client.query(
        `INSERT INTO order_assignments (order_id, employee_id, rider_id, assignment_type, status, vendor_id)
         VALUES ($1, $2, $2, $3, 'OFFERED', $4)
         ON CONFLICT (order_id, assignment_type) DO UPDATE SET
           employee_id = EXCLUDED.employee_id,
           rider_id = EXCLUDED.rider_id,
           status = 'OFFERED',
           assigned_at = NOW()`,
        [orderId, employee.user_id, purpose, vendor.vendorId]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: order.status,
        actorId: userId,
        actorRole: vendor.role,
        note: `Offered ${purpose.toLowerCase()} to ${employee.full_name}, pending their acceptance`,
      })

      await client.query('COMMIT')

      return {
        orderId,
        employeeId: employee.employee_id,
        employeeName: employee.full_name,
        purpose,
        status: 'OFFERED',
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Broadcast this order to every active rider/staff at the vendor at
   * once — first to call the accept endpoint wins. Phase 3 of the
   * rider-assignment initiative (see CLAUDE.md). Also schedules the
   * Phase 4 timeout job that re-broadcasts automatically if nobody
   * accepts in time.
   *
   * Vendor-triggered for now (an explicit button in the app) — this is
   * NOT yet wired into the automatic acceptOrder/backfillPickupAssignments
   * paths, which still call _autoAssignEmployee and silently pick one
   * person directly. Flipping those over to broadcast is a deliberately
   * separate, later step once the rider-app accept experience has been
   * proven out for real.
   */
  async broadcastToRiders(userId, orderId) {
    const vendor = await this._resolveVendorId(userId)
    if (!vendor) throw { statusCode: 403, message: 'Not a vendor', code: 'NOT_VENDOR' }

    const PICKUP_STAGE_STATUSES = ['VENDOR_ACCEPTED', 'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED']
    const DELIVERY_STAGE_STATUSES = ['PACKED', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY']

    const { rows: orderRows } = await query(
      `SELECT id, status FROM orders WHERE id = $1 AND vendor_id = $2`,
      [orderId, vendor.vendorId]
    )
    const order = orderRows[0]
    if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

    let purpose
    if (PICKUP_STAGE_STATUSES.includes(order.status)) purpose = 'PICKUP'
    else if (DELIVERY_STAGE_STATUSES.includes(order.status)) purpose = 'DELIVERY'
    else {
      throw {
        statusCode: 400,
        message: `Order is not at a stage that can be broadcast right now (currently ${order.status})`,
        code: 'INVALID_TRANSITION',
      }
    }

    // Broadcasting must never silently clobber a rider the vendor already
    // confirmed (directly assigned, or who already accepted an earlier
    // offer) — _broadcastOffer's INSERT ... ON CONFLICT unconditionally
    // overwrites whatever row is there, which previously meant a stray
    // "Broadcast" tap after a direct "Assign" would erase that assignment
    // and replace it with a pending offer to an unrelated placeholder rider.
    const { rows: existingRows } = await query(
      `SELECT status FROM order_assignments WHERE order_id = $1 AND assignment_type = $2`,
      [orderId, purpose]
    )
    if (existingRows[0] && ['ASSIGNED', 'IN_TRANSIT'].includes(existingRows[0].status)) {
      throw {
        statusCode: 409,
        message: 'This order already has a confirmed rider — reassign it directly instead of broadcasting',
        code: 'ALREADY_ASSIGNED',
      }
    }

    const result = await this._broadcastOffer({
      orderId,
      vendorId: vendor.vendorId,
      purpose,
      orderStatus: order.status,
      actorId: userId,
      actorRole: vendor.role,
    })
    if (!result) {
      throw { statusCode: 400, message: 'No active riders to broadcast to', code: 'NO_RIDERS_AVAILABLE' }
    }
    return result
  }

  /**
   * Re-broadcast an order that's still OFFERED after the Phase 4 timeout
   * — called by the BullMQ `rider-broadcast-timeout` job
   * (src/workers/processors.js), not by any HTTP route. A no-op if the
   * assignment already moved on (accepted, cancelled, or reassigned some
   * other way) since it was last checked. If there are simply no active
   * riders right now, the timeout is rescheduled anyway rather than
   * giving up — someone may become active before the next check.
   */
  async rebroadcastIfStillOffered(orderId, purpose, vendorId) {
    const { rows } = await query(
      `SELECT status FROM order_assignments WHERE order_id = $1 AND assignment_type = $2 AND vendor_id = $3`,
      [orderId, purpose, vendorId]
    )
    const assignment = rows[0]
    if (!assignment || assignment.status !== 'OFFERED') {
      return { skipped: true, reason: 'no_longer_offered' }
    }

    // order_events.new_status is NOT NULL — unlike the initial broadcast
    // (which already has the order row in hand from broadcastToRiders'
    // own lookup), a retry needs its own fetch to pass a real value.
    const { rows: orderRows } = await query(`SELECT status FROM orders WHERE id = $1`, [orderId])
    const currentOrderStatus = orderRows[0]?.status ?? null

    const result = await this._broadcastOffer({
      orderId,
      vendorId,
      purpose,
      orderStatus: currentOrderStatus,
      actorId: null,
      actorRole: 'SYSTEM',
      note: 'still unaccepted after the broadcast timeout',
    })
    if (!result) {
      logger.info({ orderId, vendorId, purpose }, 'Rider broadcast timeout: no active riders — rescheduling anyway')
      await this._scheduleBroadcastTimeout(orderId, purpose, vendorId)
      return { skipped: true, reason: 'no_active_riders' }
    }
    return { rebroadcast: true, ...result }
  }

  /**
   * Shared core for both the initial broadcast and every timeout-driven
   * retry: creates/updates the single OFFERED row (placeholder assignee,
   * is_broadcast_offer=true — see the Phase 3 note in CLAUDE.md for why),
   * records an audit event, emits the socket push, and schedules the next
   * timeout check. Returns null (no throw) when there are no active
   * riders, so callers can decide what that means for them.
   * @private
   */
  async _broadcastOffer({ orderId, vendorId, purpose, orderStatus, actorId, actorRole, note }) {
    const { rows: activeRiders } = await query(
      `SELECT ve.user_id FROM vendor_employees ve
       WHERE ve.vendor_id = $1 AND ve.is_active = true AND ve.role = 'VENDOR_RIDER'`,
      [vendorId]
    )
    if (activeRiders.length === 0) return null

    const placeholder = await this._pickLeastBusyEmployee(vendorId)
    // placeholder can only be null here if _pickLeastBusyEmployee's
    // VENDOR_STAFF fallback also came up empty, but we already confirmed
    // at least one active VENDOR_RIDER exists above, so this is just
    // defense-in-depth, not a real-world path.
    if (!placeholder) return null

    // Fetched once up front (not inside _scheduleBroadcastTimeout, which
    // would otherwise re-fetch the same setting a moment later) so the
    // persisted offer_expires_at and the actual BullMQ delay always agree
    // — Phase 6's rider-app countdown reads the former.
    const { broadcast_timeout_minutes: timeoutMinutes } = await this.riderAssignmentSettingsService.get()
    const offerExpiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000)

    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `INSERT INTO order_assignments (order_id, employee_id, rider_id, assignment_type, status, vendor_id, is_broadcast_offer, offer_expires_at)
         VALUES ($1, $2, $2, $3, 'OFFERED', $4, true, $5)
         ON CONFLICT (order_id, assignment_type) DO UPDATE SET
           employee_id = EXCLUDED.employee_id,
           rider_id = EXCLUDED.rider_id,
           status = 'OFFERED',
           is_broadcast_offer = true,
           offer_expires_at = EXCLUDED.offer_expires_at,
           assigned_at = NOW()`,
        [orderId, placeholder.user_id, purpose, vendorId, offerExpiresAt]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: orderStatus ?? null,
        newStatus: orderStatus ?? null,
        actorId,
        actorRole,
        note: note
          ? `Re-broadcast ${purpose.toLowerCase()} offer to ${activeRiders.length} active rider(s) — ${note}`
          : `Broadcast ${purpose.toLowerCase()} offer to ${activeRiders.length} active rider(s)`,
      })

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    const { rows: orderInfo } = await query(`SELECT order_number FROM orders WHERE id = $1`, [orderId])
    emitJobOfferedToRiders(
      activeRiders.map((r) => r.user_id),
      {
        orderId,
        orderNumber: orderInfo[0]?.order_number || null,
        purpose,
        expiresAt: offerExpiresAt.toISOString(),
      }
    )

    await this._scheduleBroadcastTimeout(orderId, purpose, vendorId, timeoutMinutes)

    return { orderId, purpose, riderCount: activeRiders.length, status: 'OFFERED', expiresAt: offerExpiresAt.toISOString() }
  }

  /**
   * Schedules the Phase 4 timeout check under a deterministic jobId
   * (`rider-broadcast-timeout-{orderId}-{purpose}`).
   *
   * Known edge case: BullMQ ignores a second `add()` under a jobId that's
   * still queued rather than resetting its delay. If the vendor
   * broadcasts the same order twice in quick succession (before the
   * first timeout fires), the second call's timeout silently keeps the
   * first call's original deadline rather than restarting the clock —
   * harmless (the eventual check still fires and re-broadcasts if
   * needed), just not perfectly precise. The normal sequence (initial
   * broadcast, then each retry from rebroadcastIfStillOffered right after
   * its own timeout job has already fired and been removed via
   * `removeOnComplete: true`) never hits this, since there's nothing
   * still queued at that point.
   *
   * VendorRiderService#acceptOffer removes this job on a successful
   * claim; if it fires anyway, rebroadcastIfStillOffered finds the
   * assignment no longer OFFERED and no-ops.
   * @private
   */
  async _scheduleBroadcastTimeout(orderId, purpose, vendorId, timeoutMinutes = null) {
    try {
      const minutes = timeoutMinutes ?? (await this.riderAssignmentSettingsService.get()).broadcast_timeout_minutes
      await orderQueue.add(
        'rider-broadcast-timeout',
        { type: 'rider-broadcast-timeout', orderId, purpose, vendorId },
        {
          jobId: `rider-broadcast-timeout-${orderId}-${purpose}`,
          delay: minutes * 60 * 1000,
          removeOnComplete: true,
        }
      )
    } catch (err) {
      logger.warn({ err: err.message, orderId, purpose }, 'Failed to schedule rider-broadcast-timeout job')
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
