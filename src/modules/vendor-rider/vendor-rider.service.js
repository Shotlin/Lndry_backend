import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { OrderOtpService } from '../order-otp/order-otp.service.js'
import { ORDER_STATUSES, validateTransition, recordOrderEvent } from '../../utils/state-machine.js'
import { computeRecalculatedTotals, applyRecalculatedTotals } from '../../utils/order-recalculation.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { getOrderBalanceDuePaise } from '../../utils/order-balance.js'
import { orderQueue } from '../../config/bullmq.js'

/**
 * Vendor Rider service — the restricted job-fulfillment surface for a
 * vendor's own delivery riders (VENDOR_RIDER role on vendor_employees).
 * Distinct from the unrelated platform-wide gig-rider system in
 * src/modules/delivery/ (RIDER role, no vendor_id, commission/payouts).
 */
import { emitLifecycleEvent } from '../lifecycle-notifications/lifecycle-jobs.js'

/**
 * An assisted booking ("Book With Expert Check") has no order lines until the
 * laundry inspects the garments and picks services. The Captain app's pickup
 * screens are built around at least one line (count it, photograph it), so at
 * PICKUP only, the job detail presents ONE stand-in line — never stored — and
 * the measurement/photo endpoints accept it and record it as a note/evidence
 * instead of touching totals. The Captain app itself is unchanged.
 */
export const ASSISTED_PICKUP_LINE_ID = '00000000-0000-4000-8000-00000000a551'
const ASSISTED_PICKUP_LINE_NAME = 'Garments (assisted booking)'

export class VendorRiderService {
  constructor({ fastify, otpService } = {}) {
    this.otpService = otpService || new OrderOtpService()
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  async _resolveRider(userId) {
    const { rows } = await query(
      `SELECT vendor_id, role FROM vendor_employees
       WHERE user_id = $1 AND is_active = true AND role = 'VENDOR_RIDER'
       LIMIT 1`,
      [userId]
    )
    return rows[0] ? { vendorId: rows[0].vendor_id, role: rows[0].role } : null
  }

  _parseAddress(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch {
        return {}
      }
    }
    return value
  }

  _mapJobRow(row) {
    const address = this._parseAddress(row.delivery_address)
    const lat = address.lat ?? address.latitude ?? null
    const lng = address.lng ?? address.longitude ?? null
    const addressLine = [address.addressLine1, address.city]
      .filter(Boolean)
      .join(', ')

    const totalPaise = row.total_amount != null ? Math.round(Number(row.total_amount) * 100) : null
    const amountPaidPaise = row.amount_paid != null ? Math.round(Number(row.amount_paid) * 100) : 0
    const balanceDuePaise = totalPaise != null ? Math.max(0, totalPaise - amountPaidPaise) : null

    return {
      assignment_id: row.assignment_id,
      order_id: row.order_id,
      order_number: row.order_number,
      assignment_type: row.assignment_type,
      order_status: row.order_status,
      customer_name: row.customer_name?.trim() ? row.customer_name : 'Customer',
      customer_phone: row.customer_phone,
      address_line: addressLine,
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
      scheduled_label:
        row.assignment_type === 'DELIVERY'
          ? row.vendor_delivery_slot_label
          : row.scheduled_slot_label,
      assigned_at: row.assigned_at,
      payment_method: row.payment_method ?? null,
      balance_due_paise: balanceDuePaise,
    }
  }

  async listJobs(userId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }

    const { rows } = await query(
      `SELECT oa.id AS assignment_id, oa.order_id, oa.assignment_type, oa.assigned_at,
              o.order_number, o.status AS order_status, o.delivery_address,
              o.scheduled_slot_label, o.vendor_delivery_slot_label, o.vendor_delivery_slot_at,
              o.payment_method, o.total_amount,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND status = 'PAID') AS amount_paid,
              u.name AS customer_name, u.phone AS customer_phone
       FROM order_assignments oa
       JOIN orders o ON o.id = oa.order_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE oa.employee_id = $1 AND oa.status IN ('ASSIGNED', 'IN_TRANSIT')
         AND (
           (oa.assignment_type = 'PICKUP' AND o.status IN ('VENDOR_ACCEPTED', 'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED'))
           OR (oa.assignment_type = 'DELIVERY' AND o.status IN ('PACKED', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERY_OTP_VERIFIED'))
         )
       ORDER BY oa.assigned_at ASC`,
      [userId]
    )
    return rows.map((r) => this._mapJobRow(r))
  }

  async getJobDetail(userId, orderId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }

    const { rows } = await query(
      `SELECT oa.id AS assignment_id, oa.order_id, oa.assignment_type, oa.assigned_at,
              o.order_number, o.status AS order_status, o.delivery_address,
              o.scheduled_slot_label, o.vendor_delivery_slot_label, o.vendor_delivery_slot_at,
              o.payment_method, o.total_amount, o.booking_type,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND status = 'PAID') AS amount_paid,
              u.name AS customer_name, u.phone AS customer_phone
       FROM order_assignments oa
       JOIN orders o ON o.id = oa.order_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE oa.employee_id = $1 AND oa.order_id = $2 AND oa.status IN ('ASSIGNED', 'IN_TRANSIT')
         AND (
           (oa.assignment_type = 'PICKUP' AND o.status IN ('VENDOR_ACCEPTED', 'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED'))
           OR (oa.assignment_type = 'DELIVERY' AND o.status IN ('PACKED', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERY_OTP_VERIFIED'))
         )
       LIMIT 1`,
      [userId, orderId]
    )
    const row = rows[0]
    if (!row) {
      throw { statusCode: 404, message: 'Job not found', code: 'JOB_NOT_FOUND' }
    }

    const linesRes = await query(
      `SELECT ol.id, ol.quantity, gt.name AS garment_name, gt.unit
       FROM order_lines ol
       LEFT JOIN garment_types gt ON ol.garment_type_id = gt.id
       WHERE ol.order_id = $1`,
      [orderId]
    )

    const lines = linesRes.rows.map((l) => ({
      id: l.id,
      garment_name: l.garment_name,
      unit: l.unit,
      quantity: l.quantity,
    }))
    if (row.booking_type === 'ASSISTED' && row.assignment_type === 'PICKUP' && lines.length === 0) {
      lines.push({ id: ASSISTED_PICKUP_LINE_ID, garment_name: ASSISTED_PICKUP_LINE_NAME, unit: 'piece', quantity: 1 })
    }

    return {
      ...this._mapJobRow(row),
      lines,
    }
  }

  /**
   * List jobs OFFERED to this rider, pending accept/decline — distinct
   * from listJobs (confirmed jobs, status ASSIGNED/IN_TRANSIT). Phase 2
   * of the rider-assignment initiative (see CLAUDE.md) — no broadcast
   * yet, so there is at most one relevant offer per assignment slot, but
   * the row shape is the same one Phase 3's multi-rider broadcast will
   * reuse.
   */
  async listOffers(userId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }

    // A targeted offer (Phase 2's offerToEmployee) only shows to the
    // specific person it names; a broadcast offer (Phase 3) shows to
    // every active rider at the vendor, since any of them can claim it.
    const { rows } = await query(
      `SELECT oa.id AS assignment_id, oa.order_id, oa.assignment_type, oa.assigned_at,
              oa.is_broadcast_offer, oa.offer_expires_at,
              o.order_number, o.status AS order_status, o.delivery_address,
              o.scheduled_slot_label, o.vendor_delivery_slot_label, o.vendor_delivery_slot_at,
              o.payment_method, o.total_amount,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE order_id = o.id AND status = 'PAID') AS amount_paid,
              u.name AS customer_name, u.phone AS customer_phone
       FROM order_assignments oa
       JOIN orders o ON o.id = oa.order_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE oa.status = 'OFFERED'
         AND (
           (oa.is_broadcast_offer = false AND oa.employee_id = $1)
           OR (oa.is_broadcast_offer = true AND oa.vendor_id = $2)
         )
       ORDER BY oa.assigned_at ASC`,
      [userId, rider.vendorId]
    )
    return rows.map((r) => ({
      ...this._mapJobRow(r),
      is_broadcast_offer: r.is_broadcast_offer,
      offer_expires_at: r.offer_expires_at,
    }))
  }

  /**
   * Atomically claim an OFFERED assignment — the race-safe "first to
   * accept wins" primitive Phase 3's broadcast will rely on. In today's
   * single-target scope (no broadcast yet, and the (order_id,
   * assignment_type) unique constraint means only one OFFERED row can
   * exist per slot anyway) this mainly guards against the same rider
   * double-tapping accept, or accept and decline racing each other.
   * Phase 3's true multi-candidate design is separate, not-yet-built work.
   */
  async acceptOffer(userId, orderId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // A targeted offer can only be claimed by the person it names; a
      // broadcast offer can be claimed by any active rider at the same
      // vendor — first successful UPDATE wins, since a second concurrent
      // claim's WHERE no longer matches once status flips to 'ASSIGNED'.
      const claimRes = await client.query(
        `UPDATE order_assignments SET employee_id = $1, rider_id = $1, status = 'ASSIGNED', assigned_at = NOW(), updated_at = NOW()
         WHERE order_id = $2 AND status = 'OFFERED'
           AND (
             (is_broadcast_offer = false AND employee_id = $1)
             OR (is_broadcast_offer = true AND vendor_id = $3)
           )
         RETURNING assignment_type`,
        [userId, orderId, rider.vendorId]
      )
      if (claimRes.rows.length === 0) {
        await client.query('ROLLBACK')
        throw { statusCode: 409, message: 'This offer is no longer available', code: 'OFFER_UNAVAILABLE' }
      }
      const assignmentType = claimRes.rows[0].assignment_type
      const targetStatus = assignmentType === 'PICKUP' ? 'PICKUP_ASSIGNED' : 'DELIVERY_ASSIGNED'

      const { rows } = await client.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId])
      const order = rows[0]
      if (!order) {
        await client.query('ROLLBACK')
        throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
      }

      const transition = validateTransition(order.status, targetStatus, 'VENDOR_RIDER')
      if (transition.valid) {
        await client.query(
          `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
          [targetStatus, orderId]
        )
        await recordOrderEvent(client, {
          orderId,
          oldStatus: order.status,
          newStatus: targetStatus,
          actorId: userId,
          actorRole: 'VENDOR_RIDER',
          note: 'Rider accepted the offer',
        })
      } else {
        // Order already moved on for some other reason (e.g. cancelled)
        // — the claim itself still stands (this rider now owns the
        // assignment row), but there's no valid order-status transition
        // to apply. Logged, not thrown: the accept succeeded at the
        // assignment level even though the order-level stage couldn't
        // advance.
        logger.warn(
          { orderId, currentStatus: order.status, target: targetStatus },
          'Offer accepted but order status transition was not valid'
        )
      }

      await client.query('COMMIT')

      // Best-effort cancel of the Phase 4 re-broadcast timeout — if this
      // fails or the job already fired, rebroadcastIfStillOffered's own
      // "still OFFERED?" check makes a stray re-broadcast harmless anyway.
      try {
        const job = await orderQueue.getJob(`rider-broadcast-timeout-${orderId}-${assignmentType}`)
        if (job) await job.remove()
      } catch (err) {
        logger.warn({ err: err.message, orderId, assignmentType }, 'Failed to cancel rider-broadcast-timeout job (non-critical)')
      }

      return { orderId, assignmentType, status: transition.valid ? targetStatus : order.status }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Decline a TARGETED OFFERED assignment — the order goes back to
   * needing an assignee (a vendor can offer/assign someone else; a later
   * phase's timeout worker will do this automatically). Uses the existing
   * 'CANCELLED' status value already in the CHECK constraint from the
   * legacy scaffold.
   *
   * Deliberately excludes broadcast offers (is_broadcast_offer = true) —
   * there's only one shared row for a broadcast, so "declining" it here
   * would cancel the opportunity for every other rider it was offered to,
   * not just the caller. A rider ignoring/dismissing a broadcast offer is
   * a client-side-only action (just close the prompt); nothing to call
   * here for that case. This WHERE simply won't match a broadcast row, so
   * the caller gets a clear OFFER_UNAVAILABLE rather than silently
   * cancelling something they don't have the right to cancel.
   */
  async declineOffer(userId, orderId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }

    const { rows } = await query(
      `UPDATE order_assignments SET status = 'CANCELLED', updated_at = NOW()
       WHERE order_id = $1 AND employee_id = $2 AND status = 'OFFERED' AND is_broadcast_offer = false
       RETURNING id`,
      [orderId, userId]
    )
    if (rows.length === 0) {
      throw { statusCode: 409, message: 'This offer is no longer available', code: 'OFFER_UNAVAILABLE' }
    }
    return { orderId, status: 'DECLINED' }
  }

  async _assertOwnsAssignment(userId, orderId, assignmentType) {
    const { rows } = await query(
      `SELECT id FROM order_assignments
       WHERE order_id = $1 AND employee_id = $2 AND assignment_type = $3
       LIMIT 1`,
      [orderId, userId, assignmentType]
    )
    if (rows.length === 0) {
      throw { statusCode: 403, message: 'You are not assigned to this job', code: 'NOT_ASSIGNED' }
    }
  }

  /**
   * Shared "rider is on the way" transition for either leg — a single-step
   * status change distinct from `_advanceOrder`'s two-step OTP-verified
   * flow, driving the matching order_assignments row to IN_TRANSIT too.
   */
  async _startLeg(userId, orderId, assignmentType, targetStatus) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, assignmentType)

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      )
      const order = rows[0]
      if (!order) {
        throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
      }

      const current = order.status
      const t = validateTransition(current, targetStatus, 'VENDOR_RIDER')
      if (!t.valid) {
        throw { statusCode: 400, message: t.message, code: 'INVALID_TRANSITION' }
      }

      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [targetStatus, orderId]
      )
      await recordOrderEvent(client, {
        orderId,
        oldStatus: current,
        newStatus: targetStatus,
        actorId: userId,
        actorRole: 'VENDOR_RIDER',
      })

      await client.query(
        `UPDATE order_assignments SET status = 'IN_TRANSIT', updated_at = NOW()
         WHERE order_id = $1 AND assignment_type = $2`,
        [orderId, assignmentType]
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return { orderId, status: targetStatus }
  }

  /**
   * Rider explicitly marks "on my way to pickup" — PICKUP_ASSIGNED ->
   * GOING_FOR_PICKUP. Surfaces as the customer's "Pickup Partner Coming"
   * timeline milestone.
   */
  async startPickup(userId, orderId) {
    return this._startLeg(userId, orderId, 'PICKUP', 'GOING_FOR_PICKUP')
  }

  /**
   * Rider explicitly marks "on my way to deliver" — DELIVERY_ASSIGNED/PACKED
   * -> OUT_FOR_DELIVERY. Surfaces as the customer's "Out for Delivery"
   * timeline milestone. Not strictly required before delivery-OTP verify
   * (that transition is also valid directly from DELIVERY_ASSIGNED), but
   * kept symmetric with the pickup leg for a consistent rider UX and an
   * accurate customer timeline.
   */
  async startDelivery(userId, orderId) {
    return this._startLeg(userId, orderId, 'DELIVERY', 'OUT_FOR_DELIVERY')
  }

  async submitPickupPhotos(userId, orderId, photos) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'PICKUP')

    if (!Array.isArray(photos) || photos.length === 0) {
      throw { statusCode: 400, message: 'photos array is required', code: 'VALIDATION_ERROR' }
    }

    for (const photo of photos) {
      // The assisted-booking stand-in line is not a real order_lines row.
      const lineId = photo.order_line_id === ASSISTED_PICKUP_LINE_ID ? null : (photo.order_line_id || null)
      await query(
        `INSERT INTO order_pickup_photos (order_id, order_line_id, photo_url, is_grouped, uploaded_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, lineId, photo.url, !!photo.is_grouped, userId]
      )
    }
    return { orderId, photosSaved: photos.length }
  }

  /**
   * Rider's doorstep weigh-in/recount — corrects the customer's rough
   * self-declared weight/piece-count. Applies immediately, no customer
   * approval needed (this is just fixing a guess, not an authoritative
   * recalculation — that's the vendor's later, gated step). Must happen
   * before pickup-OTP verification; enforced only by allowed order statuses
   * (UI-sequenced, same trust posture as submitPickupPhotos vs. the OTP step).
   */
  async submitMeasurements(userId, orderId, { confirmedWeightKg, lines: confirmedLines } = {}) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'PICKUP')

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT id, status, fee_breakdown, estimated_amount_paise, payable_amount_paise, booking_type
         FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      )
      const order = rows[0]
      if (!order) {
        throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
      }

      const allowedStatuses = [ORDER_STATUSES.PICKUP_ASSIGNED, ORDER_STATUSES.GOING_FOR_PICKUP]
      if (!allowedStatuses.includes(order.status)) {
        throw { statusCode: 400, message: 'Measurements can only be recorded before pickup is confirmed', code: 'INVALID_STAGE' }
      }

      const linesRes = await client.query(
        `SELECT id, garment_type_id, name, unit, rate_paise, estimated_quantity, confirmed_quantity
         FROM order_lines WHERE order_id = $1`,
        [orderId]
      )

      // Assisted booking, nothing priced yet: the captain's count is only a
      // hint for the laundry — record it, change no money.
      if (order.booking_type === 'ASSISTED' && linesRes.rows.length === 0) {
        const counted = (confirmedLines || []).find((l) => l.order_line_id === ASSISTED_PICKUP_LINE_ID)?.confirmed_quantity
        if (Number.isFinite(counted) && counted > 0) {
          await recordOrderEvent(client, {
            orderId,
            oldStatus: order.status,
            newStatus: order.status,
            actorId: userId,
            actorRole: rider.role,
            note: `Captain counted ${counted} piece(s) at pickup (assisted booking — not priced yet)`,
          })
        }
        await client.query('COMMIT')
        return {
          orderId,
          old_subtotal_paise: 0,
          new_subtotal_paise: 0,
          new_payable_amount_paise: Number(order.payable_amount_paise || 0),
        }
      }

      const computed = computeRecalculatedTotals({
        orderRow: order,
        lines: linesRes.rows,
        confirmedLines,
        confirmedWeightKg,
      })

      await applyRecalculatedTotals(client, orderId, computed)

      await client.query(
        `INSERT INTO order_reconciliations (
           order_id, stage, status, proposed_by, proposed_by_role,
           previous_subtotal_paise, proposed_subtotal_paise,
           previous_payable_amount_paise, proposed_payable_amount_paise,
           previous_weight_kg, proposed_weight_kg, line_changes
         ) VALUES ($1, 'RIDER_PICKUP', 'APPLIED', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orderId, userId, rider.role,
          computed.previousSubtotalPaise, computed.proposedSubtotalPaise,
          computed.previousPayableAmountPaise, computed.proposedPayableAmountPaise,
          computed.previousWeightKg, computed.proposedWeightKg,
          JSON.stringify(computed.lineChanges),
        ]
      )

      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_role, actor_shop_id, target_type, target_id, action, before, after)
         VALUES ($1, $2, $3, 'ORDER', $4, 'RIDER_MEASUREMENT', $5, $6)`,
        [
          userId, rider.role, rider.vendorId, orderId,
          JSON.stringify({ subtotal_paise: computed.previousSubtotalPaise }),
          JSON.stringify({ subtotal_paise: computed.proposedSubtotalPaise, confirmed_weight_kg: confirmedWeightKg }),
        ]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: order.status, // Status doesn't change — immediate apply, no gate
        actorId: userId,
        actorRole: rider.role,
        note: `Rider measurement: subtotal changed from ${computed.previousSubtotalPaise} to ${computed.proposedSubtotalPaise} paise`,
      })

      await client.query('COMMIT')

      return {
        orderId,
        old_subtotal_paise: computed.previousSubtotalPaise,
        new_subtotal_paise: computed.proposedSubtotalPaise,
        new_payable_amount_paise: computed.proposedPayableAmountPaise,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Rider confirms cash collected for a COD order's balance at delivery —
   * purely additive: COD today never marks anything paid at all, so this
   * doesn't change any existing behavior, just adds a confirmation step.
   * UI-sequenced before the delivery-OTP screen, not server-hard-gated,
   * matching the same trust posture already extended to COD elsewhere.
   */
  async collectBalance(userId, orderId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'DELIVERY')

    const { rows } = await query(
      `SELECT id, user_id, payment_method, total_amount FROM orders WHERE id = $1`,
      [orderId]
    )
    const order = rows[0]
    if (!order) {
      throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
    }
    if (order.payment_method !== 'COD') {
      throw { statusCode: 400, message: 'This order\'s balance is settled online, not by the rider', code: 'NOT_COD' }
    }

    const paidRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS amount_paid FROM payments WHERE order_id = $1 AND status = 'PAID'`,
      [orderId]
    )
    const alreadyPaidPaise = Math.round(Number(paidRes.rows[0].amount_paid) * 100)
    const totalPaise = Math.round(Number(order.total_amount) * 100)
    const balancePaise = Math.max(0, totalPaise - alreadyPaidPaise)

    if (balancePaise === 0) {
      return { orderId, balance_collected_paise: 0, message: 'No balance due' }
    }

    await query(
      `INSERT INTO payments (order_id, user_id, amount, currency, status, method, purpose)
       VALUES ($1, $2, $3, 'INR', 'PAID', 'CASH', 'BALANCE')`,
      [orderId, order.user_id, balancePaise / 100]
    )
    await query(`UPDATE orders SET payment_status = 'PAID', updated_at = NOW() WHERE id = $1`, [orderId])

    {
      const extra = { amountPaise: balancePaise }
      const dedupe = `cash:${orderId}:${balancePaise}`
      await emitLifecycleEvent('BALANCE_PAID', { orderId, dedupe, extra })
      await emitLifecycleEvent('VENDOR_PAYMENT_UPDATE', { orderId, dedupe, extra })
    }

    return { orderId, balance_collected_paise: balancePaise }
  }

  async verifyPickupOtp(userId, orderId, otp) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'PICKUP')
    await this.otpService.verifyOtp(orderId, 'PICKUP', otp)
    await this._advanceOrder(orderId, userId, 'PICKUP_OTP_VERIFIED', 'PICKED_UP', 'PICKUP')
    return { orderId, status: 'PICKED_UP' }
  }

  async verifyDeliveryOtp(userId, orderId, otp) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'DELIVERY')

    const balanceDuePaise = await getOrderBalanceDuePaise(orderId)
    if (balanceDuePaise > 0) {
      throw {
        statusCode: 400,
        message: 'Customer payment is still pending. Delivery cannot be completed.',
        code: 'PAYMENT_PENDING',
      }
    }

    await this.otpService.verifyOtp(orderId, 'DELIVERY', otp)
    await this._advanceOrder(orderId, userId, 'DELIVERY_OTP_VERIFIED', 'DELIVERED', 'DELIVERY')
    return { orderId, status: 'DELIVERED' }
  }

  /**
   * Optional delivery-proof photo, captured before the delivery OTP screen —
   * same table/pattern as submitPickupPhotos, distinguished by `context`.
   */
  async submitDeliveryPhotos(userId, orderId, photos) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'DELIVERY')

    if (!Array.isArray(photos) || photos.length === 0) {
      throw { statusCode: 400, message: 'photos array is required', code: 'VALIDATION_ERROR' }
    }

    for (const photo of photos) {
      await query(
        `INSERT INTO order_pickup_photos (order_id, order_line_id, photo_url, is_grouped, uploaded_by, context)
         VALUES ($1, $2, $3, $4, $5, 'DELIVERY_PROOF')`,
        [orderId, photo.order_line_id || null, photo.url, !!photo.is_grouped, userId]
      )
    }
    return { orderId, photosSaved: photos.length }
  }

  /**
   * Drives the order through its *_OTP_VERIFIED intermediate state to the
   * final PICKED_UP/DELIVERED status (symmetric for both legs, for a
   * consistent audit trail), then marks the matching assignment complete.
   */
  async _advanceOrder(orderId, userId, intermediateStatus, finalStatus, assignmentType) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      )
      const order = rows[0]
      if (!order) {
        throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }
      }

      const current = order.status
      const t1 = validateTransition(current, intermediateStatus, 'VENDOR_RIDER')
      if (!t1.valid) {
        throw { statusCode: 400, message: t1.message, code: 'INVALID_TRANSITION' }
      }
      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [intermediateStatus, orderId]
      )
      await recordOrderEvent(client, {
        orderId,
        oldStatus: current,
        newStatus: intermediateStatus,
        actorId: userId,
        actorRole: 'VENDOR_RIDER',
      })

      const t2 = validateTransition(intermediateStatus, finalStatus, 'VENDOR_RIDER')
      if (!t2.valid) {
        throw { statusCode: 400, message: t2.message, code: 'INVALID_TRANSITION' }
      }
      // orders.delivered_at is what settlement's aggregateDeliveredOrders()
      // date-range filters on (shop-financials.write.repository.js) — leaving
      // it null here means a genuinely delivered order silently never
      // qualifies for any settlement period, forever. order_assignments has
      // its own delivered_at (set below) but that isn't what settlement reads.
      if (finalStatus === 'DELIVERED') {
        await client.query(
          `UPDATE orders SET status = $1, delivered_at = NOW(), updated_at = NOW() WHERE id = $2`,
          [finalStatus, orderId]
        )
      } else {
        await client.query(
          `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
          [finalStatus, orderId]
        )
      }
      await recordOrderEvent(client, {
        orderId,
        oldStatus: intermediateStatus,
        newStatus: finalStatus,
        actorId: userId,
        actorRole: 'VENDOR_RIDER',
      })

      const timeCol = assignmentType === 'PICKUP' ? 'picked_up_at' : 'delivered_at'
      await client.query(
        `UPDATE order_assignments SET status = $1, ${timeCol} = NOW(), updated_at = NOW()
         WHERE order_id = $2 AND assignment_type = $3`,
        [finalStatus, orderId, assignmentType]
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}
