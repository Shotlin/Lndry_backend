// PHASE 1 SCOPE: No live tracking for customers. 
// Rider uses external Google Maps for navigation.
// Customer sees status timeline only (not GPS coordinates).

import fp from 'fastify-plugin'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import jwt from 'jsonwebtoken'
import { redis } from '../config/redis.js'
import { query } from '../config/database.js'

const RIDER_LOCATION_PREFIX = 'rider:location:'
const RIDER_LOCATION_TTL = 300 // 5 minutes
let activeIo = null

function expandLoopbackOrigins(originList) {
  const expanded = new Set(originList)

  for (const origin of originList) {
    try {
      const url = new URL(origin)
      if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1'
        expanded.add(url.toString().replace(/\/$/, ''))
      } else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost'
        expanded.add(url.toString().replace(/\/$/, ''))
      }
    } catch {
      expanded.add(origin)
    }
  }

  return Array.from(expanded)
}

export function getSocketIo() {
  return activeIo
}

export function emitSectionUpdate(io, tabKey, action) {
  if (!io) return

  io.to('themes:live').emit('section:update', {
    tab_key: tabKey,
    action,
    timestamp: Date.now(),
  })
  logger.info({ tabKey, action }, 'Section update broadcasted to all users')
}

/**
 * Socket.IO plugin for Fastify
 * Handles realtime: rider location, order status, notifications, multi-vendor events
 *
 * Rooms:
 *   user:{userId}       — personal room for order updates + notifications
 *   order:{orderId}     — order tracking room (customer + rider + admin)
 *   riders:online       — all online riders (admin dashboard)
 *   shop:{shopId}       — shop dashboard users (vendor-scoped events)
 *   hq:global           — HQ users (cross-shop monitoring)
 *   customer:{userId}   — customer app (delivery tracking)
 *   rider:{riderId}     — rider app (assignment/delivery events)
 *   admin:dashboard     — legacy admin dashboard
 *   themes:live         — all users (theme updates)
 */
async function socketioPlugin(fastify) {
  const corsOrigins = expandLoopbackOrigins(
    env.CORS_ORIGINS.split(',').map((s) => s.trim())
  )

  const io = new Server(fastify.server, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  })

  // ─── REDIS ADAPTER ────────────────────────────────────
  // Without this, room broadcasts (io.to(...).emit(...)) only reach
  // sockets connected to the *same* process — fine today at a single
  // instance, but silently drops events the moment the API runs as more
  // than one process/container (e.g. PM2 cluster mode). Two dedicated
  // ioredis connections (pub/sub can't share a connection with regular
  // commands), closed alongside `io` in the existing onClose hook below.
  const pubClient = redis.duplicate()
  const subClient = redis.duplicate()
  io.adapter(createAdapter(pubClient, subClient))

  // ─── AUTH MIDDLEWARE ──────────────────────────────────
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '')

    if (!token) {
      return next(new Error('Authentication required'))
    }

    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET)
      socket.user = decoded // { id, phone, role }
      next()
    } catch (err) {
      logger.warn({ err: err.message }, 'Socket auth failed')
      next(new Error('Invalid or expired token'))
    }
  })

  // ─── CONNECTION HANDLER ──────────────────────────────
  io.on('connection', (socket) => {
    const { id: userId, role, platform_role, shopId } = socket.user

    logger.info({ userId, socketId: socket.id, role, platform_role, shopId }, 'Socket connected')

    // Auto-join personal room
    socket.join(`user:${userId}`)

    // ─── MULTI-VENDOR ROOM SCOPING (Task 14.1) ──────
    // HQ users (platform_role set) join hq:global for cross-shop events
    if (platform_role) {
      socket.join('hq:global')
      logger.debug({ userId, room: 'hq:global' }, 'Joined HQ global room')
    }

    // Shop-scoped dashboard users join shop:{shopId} for shop-specific events
    if (shopId) {
      socket.join(`shop:${shopId}`)
      logger.debug({ userId, shopId, room: `shop:${shopId}` }, 'Joined shop room')
    }

    // Customer users join customer:{userId} for personal delivery updates
    if (role === 'CUSTOMER') {
      socket.join(`customer:${userId}`)
    }

    // Rider users join rider:{userId} for assignment/delivery events
    if (role === 'RIDER') {
      socket.join(`rider:${userId}`)
    }

    // ─── RIDER EVENTS ────────────────────────────────
    if (role === 'RIDER') {
      socket.join('riders:online')

      // Rider goes offline
      socket.on('rider:offline', async () => {
        await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)
        socket.leave('riders:online')
        logger.info({ userId }, 'Rider went offline')
      })
    }

    // ─── ORDER TRACKING ──────────────────────────────
    socket.on('order:track', (orderId) => {
      if (orderId) {
        socket.join(`order:${orderId}`)
        logger.debug({ userId, orderId }, 'Joined order tracking room')
      }
    })

    socket.on('order:untrack', (orderId) => {
      if (orderId) {
        socket.leave(`order:${orderId}`)
      }
    })

    // ─── ADMIN EVENTS ────────────────────────────────
    if (role === 'ADMIN') {
      socket.join('admin:dashboard')
    }

    // ─── THEME EVENTS ────────────────────────────────
    // All authenticated users join themes:live room for real-time theme updates
    socket.join('themes:live')

    // ─── DISCONNECT ──────────────────────────────────
    socket.on('disconnect', async (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected')

      // Clean up rider location on disconnect
      if (role === 'RIDER') {
        await redis.del(`${RIDER_LOCATION_PREFIX}${userId}`)
      }
    })
  })

  // ─── DECORATE FASTIFY ────────────────────────────────
  fastify.decorate('io', io)
  activeIo = io

  // Helper: emit order status update to customer + rider + admin
  fastify.decorate('emitOrderUpdate', (orderId, userIdsOrData, maybeData) => {
    const payload = maybeData === undefined ? userIdsOrData : maybeData
    const userIds = maybeData === undefined
      ? []
      : Array.isArray(userIdsOrData)
        ? userIdsOrData.filter(Boolean)
        : userIdsOrData
          ? [userIdsOrData]
          : []
    const data = {
      orderId,
      timestamp: new Date().toISOString(),
      ...(payload || {}),
    }

    io.to(`order:${orderId}`).emit('order:status', data)
    for (const userId of userIds) {
      io.to(`user:${userId}`).emit('order:status', data)
    }
    io.to('admin:dashboard').emit('order:status', data)
  })

  fastify.decorate('emitOrderAssignedToRider', (riderId, data) => {
    if (!riderId) return
    io.to(`user:${riderId}`).emit('order:assigned', data)
  })

  fastify.decorate('emitOrderExpiredToRider', (riderId, data) => {
    if (!riderId) return
    io.to(`user:${riderId}`).emit('order:expired', data)
  })

  // Phase 3 of the rider-assignment initiative (CLAUDE.md) — broadcasts a
  // job offer to every active rider at once via each rider's personal
  // `user:{id}` room (joined by every authenticated socket regardless of
  // role, so this works for a VENDOR_RIDER session same as any other).
  // First rider to call the accept endpoint wins; everyone else's copy of
  // the prompt just goes stale (the client finds out via a 409 if they
  // try to accept after someone else already claimed it).
  fastify.decorate('emitJobOffered', (riderIds, payload) => {
    if (!Array.isArray(riderIds) || riderIds.length === 0) return
    const data = { timestamp: new Date().toISOString(), ...payload }
    for (const riderId of riderIds) {
      if (riderId) io.to(`user:${riderId}`).emit('job:offered', data)
    }
    logger.info({ riderCount: riderIds.length, orderId: payload?.orderId }, 'Job offer broadcast to riders')
  })

  // Helper: send personal notification to user
  fastify.decorate('emitNotification', (userId, notification) => {
    io.to(`user:${userId}`).emit('notification', notification)
  })

  // Helper: get rider's latest location from Redis
  fastify.decorate('getRiderLocation', async (riderId) => {
    const data = await redis.get(`${RIDER_LOCATION_PREFIX}${riderId}`)
    return data ? JSON.parse(data) : null
  })

  // ─── ADMIN DASHBOARD EVENTS ──────────────────────────
  // Helper: emit new order alert to admin dashboard
  fastify.decorate('emitDashboardNewOrder', (order) => {
    io.to('admin:dashboard').emit('dashboard:new_order', order)
  })

  // Helper: emit low stock alert to admin dashboard
  fastify.decorate('emitDashboardLowStock', (product) => {
    io.to('admin:dashboard').emit('dashboard:low_stock', product)
  })

  // Helper: emit payment received to admin dashboard
  fastify.decorate('emitDashboardPayment', (payment) => {
    io.to('admin:dashboard').emit('dashboard:payment_received', payment)
  })

  // Helper: broadcast theme update to ALL connected users
  fastify.decorate('emitThemeUpdate', (tabKey, themeId) => {
    io.to('themes:live').emit('theme:update', {
      tabKey,
      themeId,
      timestamp: new Date().toISOString(),
    })
    logger.info({ tabKey, themeId }, 'Theme update broadcasted to all users')
  })

  // ─── MULTI-VENDOR EVENT HELPERS (Task 14.2) ──────────
  // Emit shop.low_stock to shop:{shopId} room
  // Triggered when stock drops to or below threshold but remains > 0
  fastify.decorate('emitShopLowStock', (shopId, payload) => {
    if (!shopId) return
    io.to(`shop:${shopId}`).emit('shop.low_stock', {
      vendor_id: shopId,
      ...payload,
      timestamp: new Date().toISOString(),
    })
    logger.debug({ shopId, event: 'shop.low_stock' }, 'Low stock event emitted to shop room')
  })

  // Emit shop.stock_out to shop:{shopId} room
  // Triggered when stock reaches exactly 0
  fastify.decorate('emitShopStockOut', (shopId, payload) => {
    if (!shopId) return
    io.to(`shop:${shopId}`).emit('shop.stock_out', {
      vendor_id: shopId,
      ...payload,
      timestamp: new Date().toISOString(),
    })
    logger.debug({ shopId, event: 'shop.stock_out' }, 'Stock out event emitted to shop room')
  })

  // Emit order.auto_assignment_failed to hq:global room
  // Triggered when auto-assignment cannot proceed (e.g. shop missing coordinates)
  fastify.decorate('emitAutoAssignmentFailed', (payload) => {
    io.to('hq:global').emit('order.auto_assignment_failed', {
      ...payload,
      timestamp: new Date().toISOString(),
    })
    logger.info({ orderId: payload?.order_id, event: 'order.auto_assignment_failed' }, 'Auto-assignment failed event emitted to HQ')
  })

  // Emit OUT_FOR_DELIVERY events to all relevant rooms:
  //   - customer:{userId} (rider info + live coords)
  //   - shop:{shopId} (order picked up notification)
  //   - rider:{riderId} (confirmation)
  //   - hq:global (global delivery monitoring)
  fastify.decorate('emitOutForDelivery', ({ orderId, shopId, customerId, riderId, riderName, riderPhone, orderNumber }) => {
    const basePayload = {
      order_id: orderId,
      order_number: orderNumber || null,
      timestamp: new Date().toISOString(),
    }

    // Customer channel — rider details for tracking
    if (customerId) {
      io.to(`customer:${customerId}`).emit('order.out_for_delivery', {
        ...basePayload,
        rider: { id: riderId, name: riderName || null, phone: riderPhone || null },
      })
    }

    // Shop channel — order picked up
    if (shopId) {
      io.to(`shop:${shopId}`).emit('order.out_for_delivery', {
        ...basePayload,
        rider_id: riderId,
        vendor_id: shopId,
      })
    }

    // Rider channel — pickup confirmed
    if (riderId) {
      io.to(`rider:${riderId}`).emit('order.out_for_delivery', {
        ...basePayload,
        rider_id: riderId,
      })
    }

    // HQ global — delivery monitoring
    io.to('hq:global').emit('order.out_for_delivery', {
      ...basePayload,
      vendor_id: shopId || null,
      rider_id: riderId || null,
      customer_id: customerId || null,
    })

    logger.info({ orderId, shopId, riderId, event: 'order.out_for_delivery' }, 'OUT_FOR_DELIVERY events emitted to all channels')
  })

  // Cleanup on close
  fastify.addHook('onClose', () => {
    io.close()
    pubClient.disconnect()
    subClient.disconnect()
  })

  logger.info('Socket.IO initialized')
}

export default fp(socketioPlugin, {
  name: 'socketio',
})
