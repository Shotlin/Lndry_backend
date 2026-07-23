import { query, getClient } from '../../config/database.js'
import { OrderOtpService } from '../order-otp/order-otp.service.js'
import { validateTransition, recordOrderEvent } from '../../utils/state-machine.js'

/**
 * Vendor Rider service — the restricted job-fulfillment surface for a
 * vendor's own delivery riders (VENDOR_RIDER role on vendor_employees).
 * Distinct from the unrelated platform-wide gig-rider system in
 * src/modules/delivery/ (RIDER role, no vendor_id, commission/payouts).
 */
export class VendorRiderService {
  constructor({ otpService } = {}) {
    this.otpService = otpService || new OrderOtpService()
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
              u.name AS customer_name, u.phone AS customer_phone
       FROM order_assignments oa
       JOIN orders o ON o.id = oa.order_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE oa.employee_id = $1 AND oa.status IN ('ASSIGNED', 'IN_TRANSIT')
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
              u.name AS customer_name, u.phone AS customer_phone
       FROM order_assignments oa
       JOIN orders o ON o.id = oa.order_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE oa.employee_id = $1 AND oa.order_id = $2
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

    return {
      ...this._mapJobRow(row),
      lines: linesRes.rows.map((l) => ({
        id: l.id,
        garment_name: l.garment_name,
        unit: l.unit,
        quantity: l.quantity,
      })),
    }
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
   * Rider explicitly marks "on my way to pickup" — a single-step
   * PICKUP_ASSIGNED → GOING_FOR_PICKUP transition, distinct from
   * `_advanceOrder`'s two-step OTP-verified flow. Surfaces as the
   * customer's "Pickup Partner Coming" timeline milestone.
   */
  async startPickup(userId, orderId) {
    const rider = await this._resolveRider(userId)
    if (!rider) {
      throw { statusCode: 403, message: 'Not an active rider', code: 'NOT_RIDER' }
    }
    await this._assertOwnsAssignment(userId, orderId, 'PICKUP')

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
      const t = validateTransition(current, 'GOING_FOR_PICKUP', 'VENDOR_RIDER')
      if (!t.valid) {
        throw { statusCode: 400, message: t.message, code: 'INVALID_TRANSITION' }
      }

      await client.query(
        `UPDATE orders SET status = 'GOING_FOR_PICKUP', updated_at = NOW() WHERE id = $1`,
        [orderId]
      )
      await recordOrderEvent(client, {
        orderId,
        oldStatus: current,
        newStatus: 'GOING_FOR_PICKUP',
        actorId: userId,
        actorRole: 'VENDOR_RIDER',
      })

      await client.query(
        `UPDATE order_assignments SET status = 'IN_TRANSIT', updated_at = NOW()
         WHERE order_id = $1 AND assignment_type = 'PICKUP'`,
        [orderId]
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return { orderId, status: 'GOING_FOR_PICKUP' }
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
      await query(
        `INSERT INTO order_pickup_photos (order_id, order_line_id, photo_url, is_grouped, uploaded_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, photo.order_line_id || null, photo.url, !!photo.is_grouped, userId]
      )
    }
    return { orderId, photosSaved: photos.length }
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
    await this.otpService.verifyOtp(orderId, 'DELIVERY', otp)
    await this._advanceOrder(orderId, userId, 'DELIVERY_OTP_VERIFIED', 'DELIVERED', 'DELIVERY')
    return { orderId, status: 'DELIVERED' }
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
      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [finalStatus, orderId]
      )
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
