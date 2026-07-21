import { query, getClient } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { logger } from '../../config/logger.js'

const RIDER_LOCATION_PREFIX = 'rider:location:'
const DELIVERY_OTP_PREFIX = 'delivery:otp:'
const ASSIGNABLE_ORDER_STATUSES = ['CONFIRMED', 'PREPARING', 'PACKED']
const OPEN_ASSIGNMENT_STATUSES = ['ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT']

/**
 * Delivery repository — database access for delivery operations
 */
export class DeliveryRepository {
  // ─── RIDER PROFILE ──────────────────────────────────

  async getRiderProfile(userId) {
    const { rows } = await query(
      `SELECT rp.*, u.name, u.phone, u.avatar_url
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
       WHERE rp.user_id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  async saveDocument(riderId, docType, docUrl) {
    const { rows: existing } = await query(
      `SELECT id FROM rider_documents WHERE rider_id = $1 AND doc_type = $2`,
      [riderId, docType]
    )

    if (existing.length > 0) {
      const { rows } = await query(
        `UPDATE rider_documents SET doc_url = $1, verified = false, uploaded_at = NOW()
         WHERE id = $2 RETURNING *`,
        [docUrl, existing[0].id]
      )
      return rows[0]
    }

    const { rows } = await query(
      `INSERT INTO rider_documents (rider_id, doc_type, doc_url)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [riderId, docType, docUrl]
    )
    return rows[0]
  }

  async getDocuments(riderId) {
    const { rows } = await query(
      `SELECT id, doc_type, doc_url, verified, verified_at, uploaded_at 
       FROM rider_documents 
       WHERE rider_id = $1
       ORDER BY uploaded_at DESC`,
      [riderId]
    )
    return rows
  }

  async createRiderProfile(userId, data) {
    const { rows } = await query(
      `INSERT INTO rider_profiles (user_id, vehicle_type, vehicle_number)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, data.vehicleType, data.vehicleNumber]
    )
    return rows[0]
  }

  async toggleOnline(userId, isOnline) {
    const { rows } = await query(
      `UPDATE rider_profiles SET is_online = $1, updated_at = NOW()
       WHERE user_id = $2
       RETURNING id, user_id, is_online`,
      [isOnline, userId]
    )

    // Never seed Redis with 0/0 coordinates. Let real GPS updates populate it.
    await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)

    return rows[0]
  }

  // ─── ASSIGNED ORDERS ────────────────────────────────

  async getAssignedOrders(riderId, status) {
    let sql = `
      SELECT da.id as assignment_id, da.status as assignment_status,
             da.assigned_at, da.accepted_at, da.picked_up_at, da.delivered_at,
             da.cancelled_at, da.cancel_reason, da.delivery_otp,
             da.distance_km,
             da.distance_km as estimated_distance_km,
             COALESCE(NULLIF(da.earnings, 0), NULLIF(o.delivery_fee, 0), 25) as earnings,
             COALESCE(NULLIF(re.base_fee, 0), NULLIF(da.earnings, 0), NULLIF(o.delivery_fee, 0), 25) as base_earning,
             COALESCE(re.distance_bonus, 0) as distance_bonus,
             COALESCE(re.performance_bonus, 0) as performance_bonus,
             COALESCE(re.tip_amount, 0) as tip_amount,
             0 as offer_timeout_seconds,
             NULL::timestamptz as offer_expires_at,
             CASE
               WHEN da.status = 'CANCELLED' THEN false
               ELSE true
             END as is_offer_active,
             o.id as order_id, o.order_number, o.status as order_status,
             o.total_amount, o.payment_method, o.delivery_fee,
             o.delivery_address, o.delivery_notes,
             o.items, o.estimated_delivery, o.created_at,
             u.name as customer_name, u.phone as customer_phone
      FROM order_assignments da
      JOIN orders o ON o.id = da.order_id
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN rider_earnings re ON re.order_id = da.order_id AND re.rider_id = da.rider_id
      WHERE da.rider_id = $1
    `
    const params = [riderId]

    if (status) {
      sql += ` AND da.status = $2`
      params.push(status)
    } else {
      sql += ` AND da.status = ANY($2::text[])`
      params.push(OPEN_ASSIGNMENT_STATUSES)
    }

    sql += ` ORDER BY da.assigned_at DESC`

    const { rows } = await query(sql, params)
    return rows
  }

  async getAssignmentByOrderAndRider(orderId, riderId) {
    const { rows } = await query(
      `SELECT da.id as assignment_id, da.*, o.order_number, o.user_id as customer_id, o.status as order_status,
              o.vendor_id,
              ru.name as rider_name, ru.phone as rider_phone,
              rp.current_lat as rider_lat, rp.current_lng as rider_lng
       FROM order_assignments da
       JOIN orders o ON o.id = da.order_id
       LEFT JOIN users ru ON ru.id = da.rider_id
       LEFT JOIN rider_profiles rp ON rp.user_id = da.rider_id
       WHERE da.order_id = $1 AND da.rider_id = $2
       AND da.status = ANY($3::text[])
       ORDER BY da.assigned_at DESC
       LIMIT 1`,
      [orderId, riderId, OPEN_ASSIGNMENT_STATUSES]
    )
    return rows[0] || null
  }

  async getOrderAssignmentSnapshot(orderId, riderId) {
    const { rows } = await query(
      `SELECT o.id, o.status as order_status, o.rider_id,
              da.id as assignment_id, da.status as assignment_status, da.cancel_reason
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT id, status, cancel_reason
         FROM order_assignments
         WHERE order_id = $1 AND rider_id = $2
         ORDER BY assigned_at DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) da ON true
       WHERE o.id = $1
       LIMIT 1`,
      [orderId, riderId]
    )
    return rows[0] || null
  }

  // ─── ORDER ACTIONS ──────────────────────────────────

  async acceptOrder(assignmentId, orderId, riderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query(
        `SELECT id, status, rider_id
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      )
      if (!order) {
        await client.query('ROLLBACK')
        return { conflict: true, reason: 'ORDER_NOT_FOUND' }
      }
      if (!ASSIGNABLE_ORDER_STATUSES.includes(order.status)) {
        await client.query('ROLLBACK')
        return { conflict: true, reason: 'ORDER_NOT_ASSIGNABLE' }
      }
      if (order.rider_id && order.rider_id !== riderId) {
        await client.query('ROLLBACK')
        return { conflict: true, reason: 'ORDER_ALREADY_CLAIMED' }
      }

      const { rows: [assignment] } = await client.query(
        `UPDATE order_assignments
         SET status = 'ACCEPTED', accepted_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND order_id = $2
           AND rider_id = $3
           AND status = 'ASSIGNED'
         RETURNING *`,
        [assignmentId, orderId, riderId]
      )
      if (!assignment) {
        await client.query('ROLLBACK')
        return { conflict: true, reason: 'ORDER_NOT_AVAILABLE' }
      }

      await client.query(
        `UPDATE orders
         SET rider_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [riderId, orderId]
      )

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, 'RIDER_ACCEPTED', $3, $4)`,
        [orderId, order.status, riderId, 'Delivery partner accepted the order']
      )

      const { rows: cancelledOffers } = await client.query(
        `UPDATE order_assignments
         SET status = 'CANCELLED',
             cancel_reason = 'Accepted by another rider',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1
           AND id <> $2
           AND status = 'ASSIGNED'
         RETURNING id, rider_id`,
        [orderId, assignmentId]
      )

      await client.query('COMMIT')
      return {
        conflict: false,
        assignment,
        cancelledOffers,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async rejectOrder(assignmentId, orderId, reason) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [assignment] } = await client.query(
        `UPDATE order_assignments
         SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND status = 'ASSIGNED'
         RETURNING *`,
        [assignmentId, reason]
      )
      if (!assignment) {
        await client.query('ROLLBACK')
        return { assignment: null, shouldReassign: false }
      }

      const { rows: shouldReassignRows } = await client.query(
        `SELECT o.id
         FROM orders o
         WHERE o.id = $1
           AND o.status = ANY($2::order_status[])
           AND o.rider_id IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM order_assignments da
             WHERE da.order_id = o.id
               AND da.status = ANY($3::text[])
           )
         LIMIT 1`,
        [orderId, ASSIGNABLE_ORDER_STATUSES, OPEN_ASSIGNMENT_STATUSES]
      )

      await client.query('COMMIT')
      return {
        assignment,
        shouldReassign: shouldReassignRows.length > 0,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async markPickedUp(assignmentId, orderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query(
        `SELECT status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      )

      let { rows: [assignment] } = await client.query(
        `UPDATE order_assignments
         SET status = 'IN_TRANSIT', picked_up_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'ACCEPTED'
         RETURNING *`,
        [assignmentId]
      )

      if (!assignment) {
        const { rows: [snapshot] } = await client.query(
          `SELECT da.*, o.status as order_status
           FROM order_assignments da
           JOIN orders o ON o.id = da.order_id
           WHERE da.id = $1
           LIMIT 1`,
          [assignmentId]
        )

        if (!snapshot) {
          await client.query('ROLLBACK')
          return null
        }

        if (snapshot.status === 'IN_TRANSIT' || snapshot.order_status === 'OUT_FOR_DELIVERY') {
          await client.query('COMMIT')
          return snapshot
        }

        await client.query('ROLLBACK')
        return null
      }

      await client.query(
        `UPDATE orders SET status = 'OUT_FOR_DELIVERY', updated_at = NOW()
         WHERE id = $1`,
        [orderId]
      )

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, 'PICKED_UP', $3, $4)`,
        [orderId, order?.status || 'PACKED', assignment.rider_id, 'Delivery partner picked up the order']
      )
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, 'PICKED_UP', 'OUT_FOR_DELIVERY', $2, $3)`,
        [orderId, assignment.rider_id, 'Your order is out for delivery']
      )

      await client.query('COMMIT')
      return assignment
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async markDelivered(assignmentId, orderId, proofPhotoUrl) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query(
        `SELECT status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      )

      let { rows: [assignment] } = await client.query(
        `UPDATE order_assignments
         SET status = 'DELIVERED', delivered_at = NOW(), proof_photo_url = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'IN_TRANSIT'
         RETURNING *`,
        [assignmentId, proofPhotoUrl || null]
      )

      if (!assignment) {
        const { rows: [snapshot] } = await client.query(
          `SELECT da.*, o.status as order_status
           FROM order_assignments da
           JOIN orders o ON o.id = da.order_id
           WHERE da.id = $1
           LIMIT 1`,
          [assignmentId]
        )

        if (!snapshot) {
          await client.query('ROLLBACK')
          return null
        }

        if (snapshot.status === 'DELIVERED' || snapshot.order_status === 'DELIVERED') {
          await client.query('COMMIT')
          return snapshot
        }

        await client.query('ROLLBACK')
        return null
      }

      await client.query(
        `UPDATE orders
         SET status = 'DELIVERED', delivered_at = NOW(), payment_status = 'PAID',
             proof_photo_url = $2, updated_at = NOW()
         WHERE id = $1`,
        [orderId, proofPhotoUrl || null]
      )

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, 'DELIVERED', $3, $4)`,
        [orderId, order?.status || 'OUT_FOR_DELIVERY', assignment.rider_id, 'Order delivered successfully']
      )

      await client.query(
        `UPDATE rider_profiles
         SET total_deliveries = total_deliveries + 1, updated_at = NOW()
         WHERE user_id = (SELECT rider_id FROM order_assignments WHERE id = $1)`,
        [assignmentId]
      )

      const { rows: [orderFeeRow] } = await client.query(
        `SELECT o.delivery_fee, o.order_number, COALESCE(u.name, 'Customer') AS customer_name
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         WHERE o.id = $1`,
        [orderId]
      )
      const configuredDeliveryFee = Number(orderFeeRow?.delivery_fee || 0)
      const fallbackDeliveryFee = configuredDeliveryFee > 0
        ? configuredDeliveryFee
        : 25
      const assignmentEarning = Number(assignment.earnings || 0)
      const baseFee = assignmentEarning > 0
        ? assignmentEarning
        : fallbackDeliveryFee
      const distanceBonus = 0
      const performanceBonus = 0
      const tipAmount = Number(assignment.tip_amount || 0)
      const totalPayout = baseFee + distanceBonus + performanceBonus + tipAmount

      if (assignmentEarning !== totalPayout) {
        await client.query(
          `UPDATE order_assignments
           SET earnings = $2, updated_at = NOW()
           WHERE id = $1`,
          [assignmentId, totalPayout]
        )
        assignment = {
          ...assignment,
          earnings: totalPayout,
        }
      }
      const { rows: updatedEarningRows } = await client.query(
        `UPDATE rider_earnings
         SET rider_id = $2,
             amount = $3,
             base_fee = $4,
             distance_bonus = $5,
             performance_bonus = $6,
             tip_amount = $7,
             type = 'delivery',
             description = 'Delivery earning',
             updated_at = NOW()
         WHERE order_id = $1
         RETURNING id`,
        [
          orderId,
          assignment.rider_id,
          totalPayout,
          baseFee,
          distanceBonus,
          performanceBonus,
          tipAmount,
        ]
      )
      if (updatedEarningRows.length === 0) {
        await client.query(
          `INSERT INTO rider_earnings (
             rider_id, order_id, amount, base_fee, distance_bonus,
             performance_bonus, tip_amount, type, description, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'delivery', 'Delivery earning', NOW())`,
          [
            assignment.rider_id,
            orderId,
            totalPayout,
            baseFee,
            distanceBonus,
            performanceBonus,
            tipAmount,
          ]
        )
      }

      const { rows: [todayRow] } = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_today
         FROM rider_earnings
         WHERE rider_id = $1
           AND created_at::date = CURRENT_DATE`,
        [assignment.rider_id]
      )

      const completionSummary = {
        orderId,
        orderNumber: orderFeeRow?.order_number || '',
        customerName: orderFeeRow?.customer_name || 'Customer',
        earnedAmount: totalPayout,
        baseFee,
        distanceBonus,
        performanceBonus,
        tipAmount,
        totalToday: Number(todayRow?.total_today || totalPayout),
      }

      await client.query('COMMIT')
      return {
        ...assignment,
        completionSummary,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async saveProofPhoto(orderId, riderId, proofPhotoUrl) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `UPDATE order_assignments
         SET proof_photo_url = $3, updated_at = NOW()
         WHERE order_id = $1 AND rider_id = $2
           AND status IN ('ACCEPTED', 'IN_TRANSIT', 'DELIVERED')`,
        [orderId, riderId, proofPhotoUrl]
      )

      await client.query(
        `UPDATE orders
         SET proof_photo_url = $2, updated_at = NOW()
         WHERE id = $1`,
        [orderId, proofPhotoUrl]
      )

      await client.query('COMMIT')
      return { proofPhotoUrl }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ─── DELIVERY OTP ───────────────────────────────────

  async storePickupOtp(orderId, hashedOtp) {
    await query(
      `UPDATE orders SET pickup_otp = $2, updated_at = NOW() WHERE id = $1`,
      [orderId, hashedOtp]
    )
  }

  async storeDeliveryOtp(orderId, hashedOtp) {
    await query(
      `UPDATE orders SET delivery_otp = $2, updated_at = NOW() WHERE id = $1`,
      [orderId, hashedOtp]
    )
  }

  async verifyPickupOtp(orderId, hashedOtp) {
    const { rows } = await query(
      `SELECT pickup_otp FROM orders WHERE id = $1`,
      [orderId]
    )
    if (!rows[0] || rows[0].pickup_otp !== hashedOtp) {
      return false
    }
    // single-use: clear it
    await query(
      `UPDATE orders SET pickup_otp = NULL, updated_at = NOW() WHERE id = $1`,
      [orderId]
    )
    return true
  }

  async verifyDeliveryOtp(orderId, hashedOtp) {
    const { rows } = await query(
      `SELECT delivery_otp FROM orders WHERE id = $1`,
      [orderId]
    )
    if (!rows[0] || rows[0].delivery_otp !== hashedOtp) {
      return false
    }
    // single-use: clear it
    await query(
      `UPDATE orders SET delivery_otp = NULL, updated_at = NOW() WHERE id = $1`,
      [orderId]
    )
    return true
  }

  async markAssignmentPickedUp(assignmentId, orderId, riderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [assignment] } = await client.query(
        `UPDATE order_assignments
         SET status = 'PICKED_UP', picked_up_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'ACCEPTED' AND rider_id = $2
         RETURNING *`,
        [assignmentId, riderId]
      )

      if (!assignment) {
        await client.query('ROLLBACK')
        return null
      }

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, 'CONFIRMED', 'CONFIRMED', $2, $3)`,
        [orderId, riderId, 'Garments picked up from customer']
      )

      await client.query('COMMIT')
      return assignment
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ─── STATS ──────────────────────────────────────────

  async getDeliveryStats(riderId) {
    const [assignmentStats, earningStats, weeklyRows, riderProfile] = await Promise.all([
      query(
        `SELECT
            COUNT(*)::int AS total_assigned,
            COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS total_delivered,
            COUNT(*) FILTER (
              WHERE status = 'DELIVERED'
                AND delivered_at::date = CURRENT_DATE
            )::int AS delivered_today
         FROM order_assignments
         WHERE rider_id = $1`,
        [riderId]
      ),
      query(
        `SELECT
            COALESCE(SUM(amount), 0) AS total_earnings,
            COALESCE(SUM(amount) FILTER (
              WHERE created_at::date = CURRENT_DATE
            ), 0) AS earnings_today,
            COALESCE(SUM(amount) FILTER (
              WHERE created_at >= date_trunc('week', CURRENT_DATE::timestamp)
                AND created_at < date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '7 days'
            ), 0) AS earnings_this_week
         FROM rider_earnings
         WHERE rider_id = $1`,
        [riderId]
      ),
      query(
        `SELECT
            created_at::date AS earning_date,
            COALESCE(SUM(amount), 0) AS earnings,
            COUNT(*)::int AS deliveries
         FROM rider_earnings
         WHERE rider_id = $1
           AND created_at >= date_trunc('week', CURRENT_DATE::timestamp)
           AND created_at < date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '7 days'
         GROUP BY created_at::date
         ORDER BY earning_date ASC`,
        [riderId]
      ),
      query(
        `SELECT rating, total_deliveries
         FROM rider_profiles
         WHERE user_id = $1`,
        [riderId]
      ),
    ])

    const assignment = assignmentStats.rows[0] || {}
    const earnings = earningStats.rows[0] || {}
    const profile = riderProfile.rows[0] || {}

    const totalAssigned = parseInt(assignment.total_assigned || 0, 10)
    const totalDelivered = parseInt(assignment.total_delivered || 0, 10)

    return {
      totalAssigned,
      totalDelivered,
      deliveredToday: parseInt(assignment.delivered_today || 0, 10),
      deliveriesToday: parseInt(assignment.delivered_today || 0, 10),
      totalEarnings: Number(earnings.total_earnings || 0),
      earningsToday: Number(earnings.earnings_today || 0),
      earningsThisWeek: Number(earnings.earnings_this_week || 0),
      weeklyData: this._buildCurrentWeekData(weeklyRows.rows),
      rating: parseFloat(profile.rating || 0),
      totalDeliveries: parseInt(profile.total_deliveries || 0, 10),
      acceptanceRate: totalAssigned > 0
        ? Number(((totalDelivered / totalAssigned) * 100).toFixed(2))
        : 0,
      dailyTarget: 12,
    }
  }

  async getDeliveryEarnings(riderId, period = 'month') {
    const normalizedPeriod = this._normalizeEarningsPeriod(period)
    const summaryFilter = this._getSummaryFilter(normalizedPeriod)
    const chartFilter = this._getChartFilter(normalizedPeriod)

    const [summary, dailyRows, payouts, profile] = await Promise.all([
      query(
        `SELECT
            COALESCE(SUM(amount), 0) AS total_earnings,
            COUNT(*)::int AS deliveries_count,
            COALESCE(AVG(amount), 0) AS avg_per_delivery,
            COALESCE(SUM(base_fee), 0) AS base_delivery_fees,
            COALESCE(SUM(distance_bonus), 0) AS distance_bonus,
            COALESCE(SUM(performance_bonus), 0) AS performance_bonus,
            COALESCE(SUM(tip_amount), 0) AS tips,
            (
              SELECT COALESCE(SUM(all_re.amount), 0)
              FROM rider_earnings all_re
              WHERE all_re.rider_id = $1
            ) AS lifetime_total_earnings
         FROM rider_earnings re
         WHERE re.rider_id = $1 ${summaryFilter}`,
        [riderId]
      ),
      query(
        `SELECT
            DATE(re.created_at) AS date,
            COALESCE(SUM(re.amount), 0) AS earnings,
            COUNT(*)::int AS deliveries
         FROM rider_earnings re
         WHERE re.rider_id = $1 ${chartFilter}
         GROUP BY DATE(re.created_at)
         ORDER BY date ASC`,
        [riderId]
      ),
      query(
        `SELECT
            COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS total_paid,
            COALESCE(MAX(paid_at), NULL) AS last_payout_date
         FROM rider_payouts
         WHERE rider_id = $1`,
        [riderId]
      ),
      query(
        `SELECT
            rating,
            (
              SELECT amount
              FROM rider_payouts
              WHERE rider_id = $1 AND status = 'PAID'
              ORDER BY paid_at DESC NULLS LAST, created_at DESC
              LIMIT 1
            ) AS last_payout_amount
         FROM rider_profiles
         WHERE user_id = $1`,
        [riderId]
      ),
    ])

    const summaryRow = summary.rows[0] || {}
    const payoutRow = payouts.rows[0] || {}
    const profileRow = profile.rows[0] || {}
    const totalEarnings = Number(summaryRow.total_earnings || 0)
    const lifetimeTotalEarnings = Number(summaryRow.lifetime_total_earnings || 0)
    const totalPaid = Number(payoutRow.total_paid || 0)

    return {
      period: normalizedPeriod,
      totalEarnings,
      deliveriesCount: parseInt(summaryRow.deliveries_count || 0, 10),
      avgPerDelivery: Number(summaryRow.avg_per_delivery || 0),
      breakdown: {
        baseDeliveryFees: Number(summaryRow.base_delivery_fees || 0),
        distanceBonus: Number(summaryRow.distance_bonus || 0),
        performanceBonus: Number(summaryRow.performance_bonus || 0),
        tips: Number(summaryRow.tips || 0),
      },
      dailyBreakdown: dailyRows.rows.map((row) => ({
        date: row.date,
        earnings: Number(row.earnings || 0),
        deliveries: parseInt(row.deliveries || 0, 10),
      })),
      pendingPayout: Math.max(0, lifetimeTotalEarnings - totalPaid),
      alreadyPaid: totalPaid,
      lastPayoutAmount: Number(profileRow.last_payout_amount || 0),
      lastPayoutDate: payoutRow.last_payout_date,
      rating: Number(profileRow.rating || 0),
    }
  }

  async getDeliveryPayouts(riderId, { page = 1, limit = 20 }) {
    const safePage = Number.isFinite(page) && page > 0 ? page : 1
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 20
    const offset = (safePage - 1) * safeLimit

    const [itemsResult, totalResult] = await Promise.all([
      query(
        `SELECT
            rp.id,
            rp.amount,
            rp.status,
            rp.paid_at,
            rp.payment_ref AS reference,
            COALESCE(rpr.bank_name, '') AS bank
         FROM rider_payouts rp
         LEFT JOIN rider_profiles rpr ON rpr.user_id = rp.rider_id
         WHERE rp.rider_id = $1
         ORDER BY rp.paid_at DESC NULLS LAST, rp.created_at DESC
         LIMIT $2 OFFSET $3`,
        [riderId, safeLimit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
         FROM rider_payouts
         WHERE rider_id = $1`,
        [riderId]
      ),
    ])

    const total = parseInt(totalResult.rows[0]?.total || 0, 10)
    const totalPages = total > 0 ? Math.ceil(total / safeLimit) : 1

    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        amount: Number(row.amount || 0),
        status: row.status || 'PENDING',
        paidAt: row.paid_at,
        reference: row.reference || '',
        bank: row.bank || '',
      })),
      pagination: {
        page: safePage,
        total,
        totalPages,
      },
    }
  }

  async getDeliveryCompletionSummary(orderId, riderId) {
    const [summaryResult, todayResult] = await Promise.all([
      query(
        `SELECT
            o.id AS order_id,
            o.order_number,
            COALESCE(u.name, 'Customer') AS customer_name,
            COALESCE(re.amount, COALESCE(NULLIF(da.earnings, 0), NULLIF(o.delivery_fee, 0), 25)) AS earned_amount,
            COALESCE(NULLIF(re.base_fee, 0), COALESCE(NULLIF(da.earnings, 0), NULLIF(o.delivery_fee, 0), 25)) AS base_fee,
            COALESCE(re.distance_bonus, 0) AS distance_bonus,
            COALESCE(re.performance_bonus, 0) AS performance_bonus,
            COALESCE(re.tip_amount, 0) AS tip_amount
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN order_assignments da ON da.order_id = o.id AND da.rider_id = $2
         LEFT JOIN rider_earnings re ON re.order_id = o.id AND re.rider_id = $2
         WHERE o.id = $1
         ORDER BY da.delivered_at DESC NULLS LAST, da.updated_at DESC NULLS LAST
         LIMIT 1`,
        [orderId, riderId]
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total_today
         FROM rider_earnings
         WHERE rider_id = $1
           AND created_at::date = CURRENT_DATE`,
        [riderId]
      ),
    ])

    const row = summaryResult.rows[0]
    if (!row) {
      return null
    }

    return {
      orderId: row.order_id,
      orderNumber: row.order_number || '',
      customerName: row.customer_name || 'Customer',
      earnedAmount: Number(row.earned_amount || 0),
      baseFee: Number(row.base_fee || 0),
      distanceBonus: Number(row.distance_bonus || 0),
      performanceBonus: Number(row.performance_bonus || 0),
      tipAmount: Number(row.tip_amount || 0),
      totalToday: Number(todayResult.rows[0]?.total_today || 0),
    }
  }

  // ─── LOCATION ───────────────────────────────────────

  async updateLocation(riderId, latitude, longitude) {
    await query(
      `UPDATE rider_profiles
       SET current_lat = $1, current_lng = $2, updated_at = NOW()
       WHERE user_id = $3`,
      [latitude, longitude, riderId]
    )

    await redis.setex(
      `${RIDER_LOCATION_PREFIX}${riderId}`,
      300,
      JSON.stringify({ lat: latitude, lng: longitude, updatedAt: Date.now() })
    )
  }

  async getRiderLocation(riderId) {
    const cached = await redis.get(`${RIDER_LOCATION_PREFIX}${riderId}`)
    if (cached) return JSON.parse(cached)

    const { rows } = await query(
      'SELECT current_lat as lat, current_lng as lng FROM rider_profiles WHERE user_id = $1',
      [riderId]
    )
    return rows[0] || null
  }

  async getShopInfo(shopId) {
    if (!shopId) return null
    const { rows } = await query(
      `SELECT id, name, address, phone, pickup_lat, pickup_lng
       FROM vendors
       WHERE id = $1
       LIMIT 1`,
      [shopId]
    )
    return rows[0] || null
  }

  async getStoreSettings() {
    const { rows } = await query(
      `SELECT key, value
       FROM app_settings
       WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
    )

    const settings = {
      lat: null,
      lng: null,
      name: 'LNDRY Store',
      address: 'Assigned pickup hub',
      phone: '',
    }

    for (const row of rows) {
      const key = row.key
      const value = this._normalizeSettingValue(row.value)
      if (key === 'store_lat') settings.lat = this._toNullableNumber(value)
      if (key === 'store_lng') settings.lng = this._toNullableNumber(value)
      if (key === 'store_name' && `${value}`.trim()) settings.name = `${value}`.trim()
      if (key === 'store_address' && `${value}`.trim()) settings.address = `${value}`.trim()
      if (key === 'store_phone' && `${value}`.trim()) settings.phone = `${value}`.trim()
    }

    return settings
  }

  async expireStaleAssignedOffers(riderId) {
    logger.debug({ riderId }, 'Persistent offers enabled; stale-offer expiration is disabled')
    return []
  }

  // ─── ORDER HISTORY (for rider) ──────────────────────

  async getDeliveryHistory(riderId, { limit, offset }) {
    const [orders, countResult] = await Promise.all([
      query(
        `SELECT da.id as assignment_id, da.status, da.delivered_at,
                COALESCE(NULLIF(da.earnings, 0), NULLIF(o.delivery_fee, 0), 25) as earnings,
                o.id as order_id, o.order_number, o.total_amount, o.delivery_address
         FROM order_assignments da
         JOIN orders o ON o.id = da.order_id
         WHERE da.rider_id = $1 AND da.status IN ('DELIVERED', 'CANCELLED')
         ORDER BY da.delivered_at DESC NULLS LAST
         LIMIT $2 OFFSET $3`,
        [riderId, limit, offset]
      ),
      query(
        `SELECT COUNT(*) FROM order_assignments
         WHERE rider_id = $1 AND status IN ('DELIVERED', 'CANCELLED')`,
        [riderId]
      ),
    ])

    return {
      orders: orders.rows,
      total: parseInt(countResult.rows[0].count),
    }
  }

  _normalizeSettingValue(value) {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, 'value')) {
        return value.value
      }
      return JSON.stringify(value)
    }
    return ''
  }

  _toNullableNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  _normalizeEarningsPeriod(period) {
    const value = `${period || 'month'}`.trim().toLowerCase()
    if (['today', 'week', 'month', 'all'].includes(value)) {
      return value
    }
    return 'month'
  }

  _getSummaryFilter(period) {
    switch (period) {
      case 'today':
        return `
          AND re.created_at >= CURRENT_DATE
          AND re.created_at < CURRENT_DATE + INTERVAL '1 day'
        `
      case 'week':
        return `
          AND re.created_at >= date_trunc('week', CURRENT_DATE::timestamp)
          AND re.created_at < date_trunc('week', CURRENT_DATE::timestamp) + INTERVAL '7 days'
        `
      case 'month':
        return `
          AND re.created_at >= CURRENT_DATE - INTERVAL '29 days'
          AND re.created_at < CURRENT_DATE + INTERVAL '1 day'
        `
      case 'all':
      default:
        return ''
    }
  }

  _getChartFilter(period) {
    if (period === 'all') {
      return `
        AND re.created_at >= CURRENT_DATE - INTERVAL '29 days'
        AND re.created_at < CURRENT_DATE + INTERVAL '1 day'
      `
    }
    return this._getSummaryFilter(period)
  }

  _buildCurrentWeekData(rows) {
    const startOfWeek = this._startOfCurrentWeek()
    const byDate = new Map(
      rows.map((row) => [
        this._dateKey(row.earning_date),
        {
          earnings: Number(row.earnings || 0),
          deliveries: parseInt(row.deliveries || 0, 10),
        },
      ])
    )

    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(startOfWeek)
      date.setDate(startOfWeek.getDate() + index)
      const key = this._dateKey(date)
      const found = byDate.get(key)
      return {
        date: key,
        earnings: found?.earnings || 0,
        deliveries: found?.deliveries || 0,
      }
    })
  }

  _startOfCurrentWeek() {
    const now = new Date()
    const currentDay = now.getDay()
    const diff = currentDay === 0 ? -6 : 1 - currentDay
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff)
  }

  _dateKey(value) {
    const date = value instanceof Date ? value : new Date(value)
    const year = date.getFullYear()
    const month = `${date.getMonth() + 1}`.padStart(2, '0')
    const day = `${date.getDate()}`.padStart(2, '0')
    return `${year}-${month}-${day}`
  }
}
