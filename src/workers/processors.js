import { sendPush } from '../utils/pushNotification.js'
import { sendSmsOtp } from '../utils/sms.js'
import { logger } from '../config/logger.js'
import { getClient, query } from '../config/database.js'
import { redis } from '../config/redis.js'
import { orderQueue } from '../config/bullmq.js'
import { getSocketIo } from '../plugins/socketio.plugin.js'
import { cacheDeletePattern } from '../utils/cache.js'
import { ACTIVE_THEME_CACHE_KEY, LEGACY_TAB_CACHE_KEY } from '../modules/themes/theme-cache.js'
import { emit as emitAudit } from '../utils/audit-log.js'

const DEFAULT_RIDER_EARNING = 25
const ASSIGNABLE_ORDER_STATUSES = ['CONFIRMED', 'PREPARING', 'PACKED', 'VENDOR_ACCEPTED']
const CLAIMED_ASSIGNMENT_STATUSES = ['ACCEPTED', 'PICKED_UP', 'IN_TRANSIT']
const OPEN_ASSIGNMENT_STATUSES = ['ASSIGNED', ...CLAIMED_ASSIGNMENT_STATUSES]
const RIDER_DECLINE_REASONS = new Set([
  'TOO_FAR',
  'VEHICLE_ISSUE',
  'PERSONAL_REASON',
  'OTHER',
])

/**
 * Process notification jobs
 * Job types: push, in-app, order-status, sms-otp
 */
export async function processNotificationJob(job) {
  const { type } = job.data

  switch (type) {
    case 'push':
      return handlePushNotification(job.data)

    case 'in-app':
      return handleInAppNotification(job.data)

    case 'order-status':
      return handleOrderStatusNotification(job.data)

    default:
      logger.warn({ type, jobId: job.id }, 'Unknown notification job type')
  }
}

/**
 * Process SMS jobs (OTP delivery)
 */
export async function processSmsJob(job) {
  const { phone } = job.data
  const result = await sendSmsOtp(phone)

  if (!result.success) {
    throw new Error(result.message || 'SMS send failed')
  }

  return result
}

/**
 * Process theme jobs (scheduled activation, asset warmup)
 */
export async function processThemeJob(job) {
  const { type } = job.data

  switch (type) {
    case 'scheduled-activation':
      return handleScheduledActivation(job.data)

    case 'apply-section-layout':
      return handleApplySectionLayout(job.data)

    case 'asset-warmup':
      return handleAssetWarmup(job.data)

    default:
      logger.warn({ type, jobId: job.id }, 'Unknown theme job type')
  }
}

// ─── HANDLERS ────────────────────────────────────────────

async function handlePushNotification({ userId, title, body, data }) {
  // Get user's FCM tokens
  const { rows: tokens } = await query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [userId]
  )

  if (!tokens.length) {
    logger.debug({ userId }, 'No FCM tokens — skipping push')
    return
  }

  for (const { token } of tokens) {
    await sendPush(token, { title, body, data })
  }
}

async function handleInAppNotification({ userId, title, body, notificationType, data }) {
  await query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body, notificationType || 'general', JSON.stringify(data || {})]
  )
}

async function handleOrderStatusNotification({ orderId, userId, status, orderNumber }) {
  const messages = {
    CONFIRMED: { title: 'Order Confirmed! 🎉', body: `Your order ${orderNumber} has been confirmed.` },
    PREPARING: { title: 'Order Being Prepared 🍳', body: `Your order ${orderNumber} is being prepared.` },
    PACKED: { title: 'Order Packed 📦', body: `Your order ${orderNumber} has been packed and is ready for pickup.` },
    OUT_FOR_DELIVERY: { title: 'Out for Delivery 🚴', body: `Your order ${orderNumber} is on its way!` },
    DELIVERED: { title: 'Order Delivered ✅', body: `Your order ${orderNumber} has been delivered. Enjoy!` },
    CANCELLED: { title: 'Order Cancelled ❌', body: `Your order ${orderNumber} has been cancelled.` },
    AUTO_REJECTED: { title: 'Order Auto-Rejected ❌', body: `Your order ${orderNumber} was auto-rejected as the vendor did not respond.` },
  }

  const msg = messages[status]
  if (!msg) return

  // Create in-app notification
  await query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     VALUES ($1, $2, $3, 'order', $4)`,
    [userId, msg.title, msg.body, JSON.stringify({ orderId, status })]
  )

  // Send push notification
  const { rows: tokens } = await query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [userId]
  )

  for (const { token } of tokens) {
    await sendPush(token, {
      title: msg.title,
      body: msg.body,
      data: { orderId, status, type: 'order_status' },
    })
  }
}

async function handleScheduledActivation({ themeId }) {
  if (!themeId) {
    logger.warn('Scheduled activation: missing themeId')
    return
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')

    const { rows: [theme] } = await client.query(
      `SELECT theme.id, theme.tab_id, theme.tab_key, theme.ab_variant, tab.store_key
       FROM app_themes theme
       LEFT JOIN theme_tabs tab ON tab.id = theme.tab_id
       WHERE theme.id = $1`,
      [themeId]
    )

    if (!theme) {
      await client.query('ROLLBACK')
      logger.warn({ themeId }, 'Scheduled activation: theme not found')
      return
    }

    if (theme.tab_id) {
      await client.query(
        `UPDATE app_themes
         SET status = 'draft', updated_at = NOW()
         WHERE tab_id = $1
           AND ab_variant = $2
           AND id <> $3
           AND status = 'active'`,
        [theme.tab_id, theme.ab_variant, themeId]
      )
    }

    const shouldUpdateActiveFlag =
      theme.tab_key === 'all' &&
      theme.ab_variant === 'A' &&
      theme.store_key === 'zepto'

    if (shouldUpdateActiveFlag) {
      await client.query(
        'UPDATE app_themes SET is_active = false, updated_at = NOW() WHERE is_active = true'
      )
    }

    await client.query(
      `UPDATE app_themes
       SET status = 'active',
           scheduled_at = NULL,
           is_active = CASE WHEN $2 THEN true ELSE is_active END,
           updated_at = NOW()
       WHERE id = $1`,
      [themeId, shouldUpdateActiveFlag]
    )

    await client.query('COMMIT')

    await redis.del(ACTIVE_THEME_CACHE_KEY)
    await redis.del(LEGACY_TAB_CACHE_KEY)
    await cacheDeletePattern('lndry:tab_manifest:*')
    await cacheDeletePattern('lndry:tab_home:*')
    await cacheDeletePattern('lndry:admin_theme_tabs:*')

    const io = getSocketIo()
    if (io) {
      io.to('themes:live').emit('theme:update', {
        tabKey: theme.tab_key,
        storeKey: theme.store_key || 'zepto',
        themeId,
        timestamp: new Date().toISOString(),
      })
      logger.info({ tabKey: theme.tab_key, storeKey: theme.store_key || 'zepto', themeId }, 'Theme update broadcasted to all users')
    }

    logger.info({ themeId, tabKey: theme.tab_key, storeKey: theme.store_key || 'zepto' }, 'Theme auto-activated by schedule')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err, themeId }, 'Scheduled activation failed')
    throw err
  } finally {
    client.release()
  }
}

async function handleAssetWarmup({ urls }) {
  if (!Array.isArray(urls)) return

  for (const url of urls) {
    try {
      await fetch(url, { method: 'HEAD' })
    } catch (err) {
      logger.debug({ url, err: err.message }, 'Asset warmup failed for URL')
    }
  }

  logger.info({ count: urls.length }, 'Theme asset warmup completed')
}

async function handleApplySectionLayout({ versionId, tabId }) {
  if (!versionId || !tabId) {
    logger.warn({ versionId, tabId }, 'Scheduled section layout: missing versionId or tabId')
    return
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')

    const { rows: [version] } = await client.query(
      `SELECT
         version.id,
         version.tab_id,
         version.snapshot,
         version.status,
         tab.key AS tab_key,
         tab.store_key
       FROM section_manifest_versions version
       JOIN theme_tabs tab ON tab.id = version.tab_id
       WHERE version.id = $1
         AND version.tab_id = $2`,
      [versionId, tabId]
    )

    if (!version) {
      await client.query('ROLLBACK')
      logger.warn({ versionId, tabId }, 'Scheduled section layout: version not found')
      return
    }

    if (version.status !== 'scheduled') {
      await client.query('ROLLBACK')
      logger.info({ versionId, tabId, status: version.status }, 'Scheduled section layout skipped')
      return
    }

    await client.query('DELETE FROM section_manifests WHERE tab_id = $1', [tabId])

    const snapshot = Array.isArray(version.snapshot) ? version.snapshot : []
    const orderedSnapshot = [...snapshot].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    )

    for (const section of orderedSnapshot) {
      await client.query(
        `INSERT INTO section_manifests (
           tab_id,
           section_type,
           sort_order,
           visible,
           config,
           merch_binding
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          tabId,
          section.section_type,
          section.sort_order ?? 0,
          section.visible ?? true,
          JSON.stringify(section.config || {}),
          section.merch_binding ? JSON.stringify(section.merch_binding) : null,
        ]
      )
    }

    await client.query(
      `UPDATE section_manifest_versions
       SET status = 'applied',
           scheduled_at = NULL
       WHERE id = $1`,
      [versionId]
    )

    await client.query('COMMIT')

    await cacheDeletePattern('lndry:sections:*')
    await cacheDeletePattern('lndry:tab_manifest:*')
    await cacheDeletePattern('lndry:tab_home:*')

    const io = getSocketIo()
    if (io) {
      io.to('themes:live').emit('section:update', {
        tab_key: version.tab_key,
        store_key: version.store_key || 'zepto',
        action: 'schedule',
        timestamp: new Date().toISOString(),
      })
    }

    logger.info({ versionId, tabId, tabKey: version.tab_key }, 'Scheduled section layout applied')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err, versionId, tabId }, 'Scheduled section layout failed')
    throw err
  } finally {
    client.release()
  }
}

async function handleAutoConfirm({ orderId }) {
  const { rows } = await query(
    `UPDATE orders SET status = 'CONFIRMED', updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING id, order_number, user_id`,
    [orderId]
  )

  if (rows[0]) {
    await queueAutoAssign(rows[0].id, 'AUTO_CONFIRM')
    logger.info({ orderId }, 'Order auto-confirmed')
  }
}

async function handleAutoReject({ orderId }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, status, items, user_id, order_number FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    )
    const order = rows[0]
    if (!order || order.status !== 'WAITING_VENDOR_CONFIRMATION') {
      await client.query('ROLLBACK')
      return { success: false, reason: 'ORDER_NOT_WAITING_OR_NOT_FOUND' }
    }

    await client.query(
      `UPDATE orders SET status = 'AUTO_REJECTED', payment_status = 'REFUNDED', cancelled_reason = 'Auto-rejected: Vendor confirmation timeout', updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    )

    // Record order event in state machine logs
    const { recordOrderEvent } = await import('../utils/state-machine.js')
    await recordOrderEvent(client, {
      orderId,
      oldStatus: order.status,
      newStatus: 'AUTO_REJECTED',
      actorId: null,
      actorRole: 'SYSTEM',
      note: 'Auto-rejected: Vendor confirmation timeout'
    })

    // Refund payment
    const { rows: paymentRows } = await client.query(
      `SELECT id, amount, razorpay_payment_id FROM payments WHERE order_id = $1 AND status = 'PAID' LIMIT 1`,
      [orderId]
    )
    if (paymentRows.length > 0) {
      const payment = paymentRows[0]
      const refundAmount = payment.amount
      const reason = 'Auto-rejected: Vendor confirmation timeout'

      let refundId = `ref_mock_${Math.random().toString(36).substring(2, 11)}`
      let refundStatus = 'PROCESSED'

      const { razorpay } = await import('../config/razorpay.js')
      if (razorpay && payment.razorpay_payment_id) {
        try {
          const rzpRefund = await razorpay.payments.refund(payment.razorpay_payment_id, {
            amount: Math.round(refundAmount * 100),
            notes: { reason },
          })
          refundId = rzpRefund.id
          refundStatus = 'PROCESSED'
        } catch (rzpErr) {
          logger.error({ err: rzpErr.message, orderId, paymentId: payment.id }, 'Razorpay refund failed during auto-reject')
          refundStatus = 'FAILED'
        }
      }

      await client.query(
        `UPDATE payments
         SET refund_id = $1, refund_amount = $2, refund_status = $3, status = 'REFUNDED', updated_at = NOW()
         WHERE id = $4`,
        [refundId, refundAmount, refundStatus, payment.id]
      )
    }

    // Restore stock if any retail items existed
    try {
      const { OrdersRepository } = await import('../modules/orders/orders.repository.js')
      const repo = new OrdersRepository()
      await repo.restoreStock(client, typeof order.items === 'string' ? JSON.parse(order.items) : order.items)
    } catch (stockErr) {
      logger.warn({ err: stockErr.message, orderId }, 'Stock restore skipped during auto-reject')
    }

    await client.query('COMMIT')
    logger.info({ orderId }, 'Order auto-rejected and refund completed')

    // Send customer notification
    await handleOrderStatusNotification({
      orderId: order.id,
      userId: order.user_id,
      status: 'AUTO_REJECTED',
      orderNumber: order.order_number,
    })

    return { success: true }
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err: err.message, orderId }, 'Failed to auto-reject order')
    throw err
  } finally {
    client.release()
  }
}

async function handleAssignmentTimeout({ assignmentId, orderId }) {
  logger.info(
    { assignmentId, orderId },
    'Ignoring legacy assignment-timeout job because persistent offers are enabled'
  )
  return { ignored: true }
}

export async function clearLegacyAssignmentTimeoutJobs() {
  const delayedJobs = await orderQueue.getJobs(['delayed', 'waiting'], 0, 2000)
  let removed = 0

  for (const job of delayedJobs) {
    const type = `${job?.data?.type || ''}`
    if (job?.name === 'assignment-timeout' || type === 'assignment-timeout') {
      await job.remove()
      removed += 1
    }
  }

  return removed
}

async function handleDeliveryReminder({ orderId, riderId }) {
  const { rows: tokens } = await query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [riderId]
  )

  for (const { token } of tokens) {
    await sendPush(token, {
      title: 'Delivery Reminder ⏰',
      body: 'You have a pending delivery. Please pick up the order.',
      data: { orderId, type: 'delivery_reminder' },
    })
  }
}

/**
 * Process order jobs (auto-confirm, timeout, assignment)
 */
export async function processOrderJob(job) {
  const { type } = job.data

  switch (type) {
    case 'auto-confirm':
      return handleAutoConfirm(job.data)

    case 'assignment-timeout':
      return handleAssignmentTimeout(job.data)

    case 'delivery-reminder':
      return handleDeliveryReminder(job.data)

    case 'auto-assign':
      return handleAutoAssign(job.data)

    case 'auto-assign-backlog':
      return handleAutoAssignBacklog(job.data)

    case 'auto-reject':
      return handleAutoReject(job.data)

    default:
      logger.warn({ type, jobId: job.id }, 'Unknown order job type')
  }
}

async function handleAutoAssignBacklog({ limit = 200 } = {}) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Number(limit))) : 200

  const { rows } = await query(
    `SELECT id
     FROM orders
     WHERE status = ANY($1::order_status[])
       AND rider_id IS NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [ASSIGNABLE_ORDER_STATUSES, safeLimit]
  )

  let queued = 0
  for (const row of rows) {
    const added = await queueAutoAssign(row.id, 'BACKLOG_SCAN')
    if (added) queued++
  }

  logger.info({ scanned: rows.length, queued }, 'Auto-assign backlog scan completed')
  return { scanned: rows.length, queued }
}

async function handleAutoAssign({ orderId, source = 'SYSTEM' }) {
  if (!orderId) {
    return { assigned: false, reason: 'MISSING_ORDER_ID' }
  }

  const { rows: orderRows } = await query(
    `SELECT o.id, o.order_number, o.status, o.rider_id, o.total_amount, o.payment_method,
            o.delivery_fee, o.vendor_id,
            o.items, o.delivery_address, o.created_at,
            u.name AS customer_name, u.phone AS customer_phone
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  )
  const order = orderRows[0]

  if (!order) {
    logger.warn({ orderId, source }, 'Auto-assign skipped: order not found')
    return { assigned: false, reason: 'ORDER_NOT_FOUND' }
  }

  if (!ASSIGNABLE_ORDER_STATUSES.includes(order.status)) {
    return { assigned: false, reason: `ORDER_STATUS_${order.status}` }
  }

  if (order.rider_id) {
    return { assigned: false, reason: 'RIDER_ALREADY_ASSIGNED' }
  }

  const orderAddress = parseAddress(order.delivery_address)
  const customerLat = toNumber(orderAddress.lat ?? orderAddress.latitude)
  const customerLng = toNumber(orderAddress.lng ?? orderAddress.longitude)
  const hasCustomerCoords =
    Number.isFinite(customerLat) && Number.isFinite(customerLng)
  if (!hasCustomerCoords) {
    logger.warn(
      { orderId, orderNumber: order.order_number, source },
      'Offering order with address-only customer destination; rider app will geocode fallback'
    )
  }

  // Task 12.1/12.2: Read pickup coordinates from the order's shop row
  const store = await getShopInfoForOrder(order.vendor_id)
  if (!store || !Number.isFinite(store.pickup_lat) || !Number.isFinite(store.pickup_lng)) {
    // Task 12.3: Missing shop coordinates → MANUAL_REQUIRED
    logger.warn({ orderId, shopId: order.vendor_id }, 'Auto-assign skipped: shop coordinates missing')
    await query(
      `UPDATE orders SET auto_assignment_status = 'MANUAL_REQUIRED', updated_at = NOW() WHERE id = $1`,
      [orderId]
    )
    const io = getSocketIo()
    if (io) {
      io.to('hq:global').emit('order.auto_assignment_failed', {
        orderId,
        orderNumber: order.order_number,
        shopId: order.vendor_id || null,
        reason: 'SHOP_COORDS_MISSING',
        timestamp: new Date().toISOString(),
      })
    }
    emitAudit('auto_assignment_failed', {
      actor_user_id: null,
      actor_role: null,
      actor_shop_id: order.vendor_id || null,
      target_type: 'order',
      target_id: orderId,
      before: null,
      after: { reason: 'SHOP_COORDS_MISSING', source },
    })
    return { assigned: false, reason: 'SHOP_COORDS_MISSING' }
  }

  // LNDRY Workload-Based Employee Selection:
  // Lookup active same-vendor staff (role = 'VENDOR_STAFF') with their active workload.
  const { rows: candidateEmployees } = await query(
    `SELECT ve.user_id,
            rp.current_lat, rp.current_lng,
            COALESCE(workload.count, 0)::int AS active_workload
     FROM vendor_employees ve
     JOIN users u ON u.id = ve.user_id
     LEFT JOIN rider_profiles rp ON rp.user_id = ve.user_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS count
       FROM order_assignments oa
       WHERE oa.rider_id = ve.user_id
         AND oa.status IN ('ASSIGNED', 'ACCEPTED', 'IN_TRANSIT')
     ) workload ON true
     WHERE ve.vendor_id = $1
       AND ve.role = 'VENDOR_STAFF'
       AND ve.is_active = true
       AND ve.deleted_at IS NULL
       AND u.is_active = true
     ORDER BY active_workload ASC, ve.created_at ASC
     LIMIT 10000`,
    [order.vendor_id]
  )

  if (!candidateEmployees.length) {
    return { assigned: false, reason: 'NO_AVAILABLE_RIDERS' }
  }

  const candidatesWithDistance = []

  for (const employee of candidateEmployees) {
    let lat = toNumber(employee.current_lat)
    let lng = toNumber(employee.current_lng)

    try {
      const cached = await redis.get(`rider:location:${employee.user_id}`)
      if (cached) {
        const parsed = JSON.parse(cached)
        lat = toNumber(parsed.lat, lat)
        lng = toNumber(parsed.lng, lng)
      }
    } catch (_) {
      // Ignore Redis parse/cache errors and fallback to DB coordinates.
    }

    let distance = null
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const resolvedDistance = haversineDistanceKm(store.pickup_lat, store.pickup_lng, lat, lng)
      if (Number.isFinite(resolvedDistance)) {
        distance = resolvedDistance
      }
    }

    candidatesWithDistance.push({
      riderId: employee.user_id,
      distanceKm: distance,
      activeWorkload: employee.active_workload
    })
  }

  // Workload is primary sort key, distance is secondary
  candidatesWithDistance.sort((a, b) => {
    if (a.activeWorkload !== b.activeWorkload) {
      return a.activeWorkload - b.activeWorkload
    }
    const aDistance = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY
    const bDistance = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY
    return aDistance - bDistance
  })

  // Assign to the single employee with the lowest active work count
  const selectedCandidates = candidatesWithDistance.slice(0, 1)

  if (!selectedCandidates.length) {
    return { assigned: false, reason: 'NO_AVAILABLE_RIDERS' }
  }

  const client = await getClient()
  let assignments = []
  let hasOpenAssignedOffers = false
  const riderEarning = resolveRiderEarning(order.delivery_fee)

  try {
    await client.query('BEGIN')

    const { rows: lockedRows } = await client.query(
      `SELECT id, status, rider_id
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    )
    const lockedOrder = lockedRows[0]
    if (!lockedOrder) {
      await client.query('ROLLBACK')
      return { assigned: false, reason: 'ORDER_NOT_FOUND_AT_LOCK' }
    }
    if (!ASSIGNABLE_ORDER_STATUSES.includes(lockedOrder.status) || lockedOrder.rider_id) {
      await client.query('ROLLBACK')
      return { assigned: false, reason: 'ORDER_NOT_ASSIGNABLE_AT_LOCK' }
    }

    const { rows: existingAssignments } = await client.query(
      `SELECT id, rider_id, status, cancel_reason, earnings, distance_km, assigned_at, created_at
       FROM order_assignments
       WHERE order_id = $1
       ORDER BY assigned_at DESC NULLS LAST, created_at DESC`,
      [orderId]
    )

    if (existingAssignments.some((row) => CLAIMED_ASSIGNMENT_STATUSES.includes(row.status))) {
      await client.query('ROLLBACK')
      return { assigned: false, reason: 'ORDER_ALREADY_CLAIMED_AT_LOCK' }
    }

    const latestAssignmentByRider = new Map()
    hasOpenAssignedOffers = existingAssignments.some((row) => row.status === 'ASSIGNED')
    for (const row of existingAssignments) {
      if (!row?.rider_id || latestAssignmentByRider.has(row.rider_id)) {
        continue
      }
      latestAssignmentByRider.set(row.rider_id, row)
    }

    for (const candidate of selectedCandidates) {
      const existing = latestAssignmentByRider.get(candidate.riderId)

      if (existing && OPEN_ASSIGNMENT_STATUSES.includes(existing.status)) {
        continue
      }

      if (existing && isPermanentDecline(existing.cancel_reason)) {
        continue
      }

      let assignmentRows = []

      if (existing && canReopenCancelledOffer(existing.cancel_reason)) {
        const reopened = await client.query(
          `UPDATE order_assignments
           SET status = 'ASSIGNED',
               assigned_at = NOW(),
               accepted_at = NULL,
               picked_up_at = NULL,
               delivered_at = NULL,
               cancelled_at = NULL,
               cancel_reason = NULL,
               delivery_otp = NULL,
               proof_photo_url = NULL,
               earnings = $2,
               distance_km = $3,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, order_id, rider_id, status, assigned_at, earnings, distance_km`,
          [existing.id, riderEarning, candidate.distanceKm]
        )
        assignmentRows = reopened.rows
      } else if (!existing) {
        const inserted = await client.query(
          `INSERT INTO order_assignments (
            order_id,
            rider_id,
            status,
            assigned_at,
            earnings,
            distance_km
          )
           SELECT $1, $2, 'ASSIGNED', NOW(), $3, $4
           WHERE NOT EXISTS (
             SELECT 1
             FROM order_assignments da
             WHERE da.order_id = $1
               AND da.rider_id = $2
               AND da.status = ANY($5::text[])
           )
           RETURNING id, order_id, rider_id, status, assigned_at, earnings, distance_km`,
          [orderId, candidate.riderId, riderEarning, candidate.distanceKm, OPEN_ASSIGNMENT_STATUSES]
        )
        assignmentRows = inserted.rows
      }

      const inserted = assignmentRows[0]
      if (inserted) {
        latestAssignmentByRider.set(candidate.riderId, inserted)
        assignments.push({
          ...inserted,
          distanceKm: toNumber(inserted.distance_km, candidate.distanceKm),
        })

        // Transition order status in database
        let nextStatus = null
        if (lockedOrder.status === 'VENDOR_ACCEPTED') {
          nextStatus = 'PICKUP_ASSIGNED'
        } else if (lockedOrder.status === 'PACKED') {
          nextStatus = 'DELIVERY_ASSIGNED'
        }

        if (nextStatus) {
          await client.query(
            `UPDATE orders
             SET status = $1, updated_at = NOW()
             WHERE id = $2`,
            [nextStatus, orderId]
          )
          
          const { recordOrderEvent } = await import('../utils/state-machine.js')
          await recordOrderEvent(client, {
            orderId,
            oldStatus: lockedOrder.status,
            newStatus: nextStatus,
            actorId: null,
            actorRole: 'SYSTEM',
            note: 'Auto-assigned employee to order'
          })
        }
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err, orderId, source }, 'Auto-assign transaction failed')
    throw err
  } finally {
    client.release()
  }

  if (!assignments.length) {
    // R28.4 — fire-and-forget audit for auto_assignment_failed
    emitAudit('auto_assignment_failed', {
      actor_user_id: null,
      actor_role: null,
      actor_shop_id: order.vendor_id || null,
      target_type: 'order',
      target_id: orderId,
      before: null,
      after: {
        reason: hasOpenAssignedOffers
          ? 'OFFERS_ALREADY_SYNCHRONIZED'
          : 'NO_ELIGIBLE_RIDER_OFFERS_CREATED',
        source,
      },
    })

    return {
      assigned: false,
      reason: hasOpenAssignedOffers
        ? 'OFFERS_ALREADY_SYNCHRONIZED'
        : 'NO_ELIGIBLE_RIDER_OFFERS_CREATED',
    }
  }

  const io = getSocketIo()

  for (const assignment of assignments) {
    const payload = buildAssignedPayload({
      order,
      assignment,
      store,
      estimatedDistanceKm: assignment.distanceKm,
      riderEarning,
    })
    if (io) {
      io.to(`user:${assignment.rider_id}`).emit('order:assigned', payload)
    }
    await sendAssignedOrderPush({
      riderId: assignment.rider_id,
      payload,
    })
  }

  logger.info(
    {
      orderId,
      assignmentCount: assignments.length,
      riderIds: assignments.map((item) => item.rider_id),
      source,
    },
    'Order auto-assigned with rider fanout'
  )

  return {
    assigned: true,
    orderId,
    offers: assignments.map((item) => ({
      assignmentId: item.id,
      riderId: item.rider_id,
      distanceKm: Number.isFinite(item.distanceKm)
        ? Number(item.distanceKm.toFixed(2))
        : null,
    })),
  }
}

async function queueAutoAssign(orderId, source) {
  if (!orderId) return false

  try {
    await orderQueue.add(
      'auto-assign',
      { type: 'auto-assign', orderId, source },
      {
        jobId: `auto-assign-${orderId}`,
        removeOnComplete: true,
      }
    )
    return true
  } catch (err) {
    logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
    return false
  }
}

async function shouldRequeueOrder(orderId) {
  if (!orderId) return false

  const { rows } = await query(
    `SELECT o.id
     FROM orders o
     WHERE o.id = $1
       AND o.status = ANY($3::order_status[])
       AND o.rider_id IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM order_assignments da
         WHERE da.order_id = o.id
           AND da.status = ANY($2::text[])
       )
     LIMIT 1`,
    [orderId, OPEN_ASSIGNMENT_STATUSES, ASSIGNABLE_ORDER_STATUSES]
  )

  return rows.length > 0
}

async function cancelStaleAssignedOffers(orderId) {
  logger.debug({ orderId }, 'Persistent offers enabled; stale-offer cancellation is disabled')
  return 0
}

async function getShopInfoForOrder(shopId) {
  if (!shopId) return null
  const { rows } = await query(
    `SELECT id, name, address, phone, pickup_lat, pickup_lng
     FROM vendors
     WHERE id = $1
     LIMIT 1`,
    [shopId]
  )
  const row = rows[0]
  if (!row) return null
  return {
    ...row,
    pickup_lat: toNumber(row.pickup_lat),
    pickup_lng: toNumber(row.pickup_lng),
  }
}

async function getStoreSettings() {
  const { rows } = await query(
    `SELECT key, value
     FROM app_settings
     WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
  )

  const settings = {
    lat: 0,
    lng: 0,
    name: 'LNDRY Store',
    address: 'Pickup location',
    phone: '',
  }

  for (const row of rows) {
    const key = row.key
    const value = normalizeSettingValue(row.value)
    if (key === 'store_lat') settings.lat = toNumber(value, 0)
    if (key === 'store_lng') settings.lng = toNumber(value, 0)
    if (key === 'store_name' && `${value}`.trim()) settings.name = `${value}`.trim()
    if (key === 'store_address' && `${value}`.trim()) settings.address = `${value}`.trim()
    if (key === 'store_phone' && `${value}`.trim()) settings.phone = `${value}`.trim()
  }

  return settings
}

function normalizeSettingValue(value) {
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

function buildAssignedPayload({
  order,
  assignment,
  store,
  estimatedDistanceKm,
  riderEarning,
}) {
  const address = parseAddress(order.delivery_address)
  const safeDistanceKm = Number.isFinite(estimatedDistanceKm)
    ? estimatedDistanceKm
    : Number.isFinite(toNumber(assignment.distance_km))
      ? toNumber(assignment.distance_km)
      : null
  const durationMinutes = safeDistanceKm != null && safeDistanceKm > 0
    ? Math.max(3, Math.round((safeDistanceKm / 20) * 60))
    : 0

  return {
    type: 'ORDER_ASSIGNED',
    orderId: order.id,
    assignmentId: assignment.id,
    orderNumber: order.order_number,
    status: 'ASSIGNED',
    totalAmount: toNumber(order.total_amount, 0),
    paymentMethod: order.payment_method || 'ONLINE',
    estimatedDistance: safeDistanceKm == null
      ? null
      : Number(safeDistanceKm.toFixed(2)),
    estimatedDuration: durationMinutes,
    riderEarning: resolveRiderEarning(assignment.earnings, riderEarning),
    offerTimeoutSeconds: 0,
    offerExpiresAt: null,
    isOfferActive: true,
    items: parseItems(order.items),
    customerAddress: {
      name: order.customer_name || address.name || 'Customer',
      address: resolveAddressText(address),
      landmark: address.landmark || '',
      phone: order.customer_phone || address.phone || '',
      lat: toNumber(address.lat ?? address.latitude, 0),
      lng: toNumber(address.lng ?? address.longitude, 0),
    },
    storeAddress: {
      name: store.name,
      address: store.address,
      landmark: '',
      phone: store.phone,
      lat: store.pickup_lat,
      lng: store.pickup_lng,
    },
  }
}

async function sendAssignedOrderPush({ riderId, payload }) {
  if (!riderId || !payload) {
    return
  }

  const { rows: tokens } = await query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [riderId]
  )

  if (!tokens.length) {
    return
  }

  const itemCount = Array.isArray(payload.items)
    ? payload.items.reduce((total, item) => total + toNumber(item?.quantity, 0), 0)
    : 0
  const body = itemCount > 0
    ? `${itemCount} items • Earn ₹${toNumber(payload.riderEarning, DEFAULT_RIDER_EARNING).toFixed(0)}`
    : `Earn ₹${toNumber(payload.riderEarning, DEFAULT_RIDER_EARNING).toFixed(0)} on this order`
  const pushData = buildAssignedPushData(payload)

  await Promise.allSettled(
    tokens.map(({ token }) =>
      sendPush(token, {
        title: 'New delivery offer',
        body,
        data: pushData,
      })
    )
  )
}

function buildAssignedPushData(payload) {
  const pushPayload = {
    type: payload.type || 'ORDER_ASSIGNED',
    orderId: payload.orderId,
    assignmentId: payload.assignmentId,
    orderNumber: payload.orderNumber,
    status: payload.status,
    totalAmount: payload.totalAmount,
    paymentMethod: payload.paymentMethod,
    estimatedDistance: payload.estimatedDistance ?? '',
    estimatedDuration: payload.estimatedDuration ?? '',
    riderEarning: payload.riderEarning,
    offerTimeoutSeconds: payload.offerTimeoutSeconds,
    offerExpiresAt: payload.offerExpiresAt ?? '',
    isOfferActive: payload.isOfferActive ?? true,
    items: JSON.stringify(payload.items || []),
    customerAddress: JSON.stringify(payload.customerAddress || {}),
    storeAddress: JSON.stringify(payload.storeAddress || {}),
  }

  return Object.fromEntries(
    Object.entries(pushPayload).filter(([, value]) => value !== null && value !== undefined)
  )
}

function canReopenCancelledOffer(cancelReason) {
  return normalizeCancelReason(cancelReason) === 'OFFER_EXPIRED'
}

function isPermanentDecline(cancelReason) {
  return RIDER_DECLINE_REASONS.has(normalizeCancelReason(cancelReason))
}

function normalizeCancelReason(value) {
  return `${value || ''}`
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase()
}

function parseAddress(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (_) {
      return { address: value }
    }
  }
  if (typeof value === 'object') return value
  return {}
}

function resolveAddressText(address) {
  if (!address || typeof address !== 'object') {
    return 'Delivery address unavailable'
  }

  const direct = firstNonEmptyString(
    address.address,
    address.fullAddress,
    address.full_address,
    address.formattedAddress,
    address.formatted_address,
    address.addressLine1,
    address.address_line1,
    address.address_line_1,
    address.address_line
  )
  if (direct) return direct

  const parts = [
    firstNonEmptyString(address.addressLine1, address.address_line1, address.address_line_1, address.address_line),
    firstNonEmptyString(address.addressLine2, address.address_line2, address.address_line_2),
    firstNonEmptyString(address.area),
    firstNonEmptyString(address.city),
    firstNonEmptyString(address.state),
    firstNonEmptyString(address.pincode, address.postalCode, address.postal_code),
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(', ') : 'Delivery address unavailable'
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${value}`
    }
  }
  return ''
}

function parseItems(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch (_) {
      return []
    }
  }
  return []
}

function toNumber(value, fallback = Number.NaN) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function resolveRiderEarning(value, fallback = DEFAULT_RIDER_EARNING) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }

  const fallbackParsed = Number(fallback)
  if (Number.isFinite(fallbackParsed) && fallbackParsed > 0) {
    return fallbackParsed
  }

  return DEFAULT_RIDER_EARNING
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
