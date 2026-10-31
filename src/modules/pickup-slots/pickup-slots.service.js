import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'

const SLOT_TZ_OFFSET_MS = 330 * 60 * 1000 // IST, UTC+05:30

// A pickup can't be arranged in the last stretch of a window, so a slot stops
// being offered once this little time (or less) is left before it ends.
// e.g. the 2:00-4:00 PM slot disappears at 3:30 PM.
const SLOT_MIN_REMAINING_SECONDS = 30 * 60

const timeToSeconds = (value) => {
  const [h = '0', m = '0', s = '0'] = `${value}`.split(':')
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

/** True when a slot ending at [endTime] (HH:MM[:SS]) can still take a pickup at [nowTimeIst]. */
const hasEnoughTimeLeft = (endTime, nowTimeIst) =>
  timeToSeconds(endTime) - timeToSeconds(nowTimeIst) > SLOT_MIN_REMAINING_SECONDS

export class SlotsService {
  /**
   * The pickup slots this ONE vendor offers on [bookingDate] (a calendar day),
   * with room left. Everything is derived from this vendor's own configured
   * weekly slots — a day the vendor is closed simply has none, whatever any
   * other vendor does.
   *
   * @param {string} vendorId
   * @param {string} bookingDate `YYYY-MM-DD`
   * @param {Date} [now] injectable clock (tests)
   */
  async getAvailableSlots(vendorId, bookingDate, now = new Date()) {
    // The weekday belongs to the CALENDAR DATE itself, not to the server's
    // timezone: read it from the date's own year/month/day.
    const dayMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(`${bookingDate || ''}`)
    let dayOfWeek
    if (dayMatch) {
      dayOfWeek = new Date(Date.UTC(Number(dayMatch[1]), Number(dayMatch[2]) - 1, Number(dayMatch[3]))).getUTCDay()
    } else {
      const dateObj = new Date(bookingDate)
      if (!Number.isFinite(dateObj.getTime())) {
        throw { statusCode: 400, message: 'Invalid booking date' }
      }
      dayOfWeek = dateObj.getDay() // 0 = Sunday, 6 = Saturday
    }

    // 1. Get all configured slots for the day of week
    const { rows: allSlots } = await query(
      `SELECT id, vendor_id, day_of_week, start_time, end_time, max_orders, is_active
       FROM vendor_slots
       WHERE vendor_id = $1 AND day_of_week = $2 AND is_active = true`,
      [vendorId, dayOfWeek]
    )

    // A slot that has ended today, or has only 30 minutes or less left, can't
    // be booked. (Pickups are served in India Standard Time.)
    const ist = new Date(now.getTime() + SLOT_TZ_OFFSET_MS)
    const todayIst = ist.toISOString().slice(0, 10)
    const nowTimeIst = ist.toISOString().slice(11, 19)
    const bookingDay = dayMatch ? `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}` : null
    const slots =
      bookingDay === todayIst
        ? allSlots.filter((slot) => hasEnoughTimeLeft(slot.end_time, nowTimeIst))
        : allSlots

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
        `SELECT id, max_orders, end_time FROM vendor_slots WHERE id = $1 FOR UPDATE`,
        [slotId]
      )
      if (slotRows.length === 0) {
        throw { statusCode: 404, message: 'Pickup slot not found' }
      }
      const slot = slotRows[0]

      // Same cut-off as the listing: a slot with 30 minutes or less left today
      // is closed, even if the customer's screen was still showing it.
      const nowIst = new Date(Date.now() + SLOT_TZ_OFFSET_MS)
      if (
        `${bookingDate}`.slice(0, 10) === nowIst.toISOString().slice(0, 10) &&
        !hasEnoughTimeLeft(slot.end_time, nowIst.toISOString().slice(11, 19))
      ) {
        throw { statusCode: 409, message: 'This pickup slot is no longer available' }
      }

      // 1b. One live hold per customer per laundry. The checkout screen asks for
      // a hold every time it refreshes the quote (address change, slot change,
      // coupon ...); stacking them let a single customer silently use up a
      // slot's whole capacity and show "fully booked" to everyone else.
      // Supersede this customer's earlier holds with this laundry first, so
      // their capacity is counted once, then re-check capacity.
      await client.query(
        `UPDATE slot_holds SET status = 'RELEASED'
          WHERE customer_id = $1 AND vendor_id = $2 AND status = 'ACTIVE' AND expires_at > NOW()`,
        [userId, vendorId]
      )

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
      `UPDATE slot_holds SET status = 'RELEASED' WHERE id = $1 AND customer_id = $2 AND status = 'ACTIVE'`,
      [holdId, userId]
    )
    return rowCount > 0
  }
}
