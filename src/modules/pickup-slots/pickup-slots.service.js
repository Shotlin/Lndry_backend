import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'

export class SlotsService {
  async getAvailableSlots(vendorId, bookingDate) {
    const dateObj = new Date(bookingDate)
    if (!Number.isFinite(dateObj.getTime())) {
      throw { statusCode: 400, message: 'Invalid booking date' }
    }
    const dayOfWeek = dateObj.getDay() // 0 = Sunday, 6 = Saturday

    // 1. Get all configured slots for the day of week
    const { rows: slots } = await query(
      `SELECT id, vendor_id, day_of_week, start_time, end_time, max_orders, is_active
       FROM vendor_slots
       WHERE vendor_id = $1 AND day_of_week = $2 AND is_active = true`,
      [vendorId, dayOfWeek]
    )

    if (slots.length === 0) {
      return []
    }

    // 2. Count active holds and orders for each slot
    const slotIds = slots.map(s => s.id)
    const { rows: counts } = await query(
      `SELECT
         vs.id AS slot_id,
         (SELECT COUNT(*)::int FROM slot_holds WHERE slot_id = vs.id AND booking_date = $1 AND expires_at > NOW() AND status = 'ACTIVE') AS holds_count,
         (SELECT COUNT(*)::int FROM orders WHERE vendor_slot_id = vs.id AND pickup_date = $1 AND status NOT IN ('PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')) AS orders_count
       FROM vendor_slots vs
       WHERE vs.id = ANY($2::uuid[])`,
      [bookingDate, slotIds]
    )

    const countMap = new Map(counts.map(c => [c.slot_id, c]))

    return slots.map(slot => {
      const cnt = countMap.get(slot.id) || { holds_count: 0, orders_count: 0 }
      const totalBooked = cnt.holds_count + cnt.orders_count
      const remaining = Math.max(0, slot.max_orders - totalBooked)
      return {
        id: slot.id,
        startTime: slot.start_time,
        endTime: slot.end_time,
        maxOrders: slot.max_orders,
        remainingCapacity: remaining
      }
    }).filter(slot => slot.remainingCapacity > 0)
  }

  async holdSlot(userId, vendorId, slotId, bookingDate, quoteId) {
    if (!quoteId) {
      throw { statusCode: 400, message: 'quote_id is required' }
    }

    // Validate quote ownership
    const quoteRes = await query('SELECT customer_id, vendor_id FROM quotes WHERE id = $1', [quoteId])
    if (quoteRes.rows.length === 0) {
      throw { statusCode: 404, message: 'Quotation not found' }
    }
    const quote = quoteRes.rows[0]
    if (quote.customer_id !== userId) {
      throw { statusCode: 403, message: 'Forbidden - quote ownership validation failed' }
    }
    if (quote.vendor_id !== vendorId) {
      throw { statusCode: 400, message: 'Vendor mismatch' }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // 1. SELECT FOR UPDATE to lock slot and enforce atomic holds
      const { rows: slotRows } = await client.query(
        `SELECT id, max_orders FROM vendor_slots WHERE id = $1 FOR UPDATE`,
        [slotId]
      )
      if (slotRows.length === 0) {
        throw { statusCode: 404, message: 'Pickup slot not found' }
      }
      const slot = slotRows[0]

      // 2. Count current active holds and orders
      const { rows: holdRows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM slot_holds WHERE slot_id = $1 AND booking_date = $2 AND expires_at > NOW() AND status = 'ACTIVE'`,
        [slotId, bookingDate]
      )
      const { rows: orderRows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM orders WHERE vendor_slot_id = $1 AND pickup_date = $2 AND status NOT IN ('PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')`,
        [slotId, bookingDate]
      )

      const activeBookings = (holdRows[0]?.count || 0) + (orderRows[0]?.count || 0)
      if (activeBookings >= slot.max_orders) {
        throw { statusCode: 409, message: 'Pickup slot is fully booked' }
      }

      // 3. Create short-lived hold (10 min expiry)
      const { rows: hold } = await client.query(
        `INSERT INTO slot_holds (vendor_id, slot_id, customer_id, user_id, quote_id, booking_date, expires_at, status)
         VALUES ($1, $2, $3, $3, $4, $5, NOW() + INTERVAL '10 minutes', 'ACTIVE')
         RETURNING id, expires_at`,
        [vendorId, slotId, userId, quoteId, bookingDate]
      )

      await client.query('COMMIT')
      logger.info({ userId, slotId, holdId: hold[0].id }, 'Pickup slot held successfully')
      return hold[0]
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err: err.message, slotId, userId }, 'Failed to hold slot')
      throw err
    } finally {
      client.release()
    }
  }

  async releaseHold(userId, holdId) {
    const { rowCount } = await query(
      `UPDATE slot_holds SET status = 'RELEASED', updated_at = NOW() WHERE id = $1 AND customer_id = $2 AND status = 'ACTIVE'`,
      [holdId, userId]
    )
    return rowCount > 0
  }
}
