import { getClient } from '../../config/database.js'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ORDER_STATUS, ACTIVE_ORDER_STATUSES } from '../../constants/orderStatus.js'
import { generateInvoicePDF } from '../../utils/invoiceGenerator.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../notifications/customer-order-event.helper.js'

// Lazy-loaded collaborator instances (avoids circular imports)
import { CartRepository } from '../../../archived_modules/cart/cart.repository.js'
import { CartService } from '../../../archived_modules/cart/cart.service.js'
import { AddressesRepository } from '../addresses/addresses.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { CouponsService } from '../coupons/coupons.service.js'
import { ShopProductsRepository } from '../shop-garment_rates/shop-garment_rates.repository.js'
import { ShopProductsService } from '../shop-garment_rates/shop-garment_rates.service.js'
import { OrderSplitterService } from './order-splitter.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from '../../../archived_modules/cart/totals-engine.service.js'

const DELIVERY_FEE = 25 // ₹25 flat delivery fee
const PLATFORM_FEE = 5 // ₹5 platform fee
const FREE_DELIVERY_THRESHOLD = 499 // Free delivery above ₹499
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Orders service — business logic for order placement & management
 */
export class OrdersService {
  constructor(repository, fastify = null, options = {}) {
    this.repo = repository
    this.fastify = fastify

    // Collaborators
    this.cartRepo = options.cartRepository || new CartRepository()
    this.cartService = options.cartService || new CartService(this.cartRepo)
    this.addressRepo = options.addressesRepository || new AddressesRepository()
    this.couponsRepo = options.couponsRepository || new CouponsRepository()
    this.couponsService =
      options.couponsService || new CouponsService(this.couponsRepo)
    this.shopProductsRepo =
      options.shopProductsRepository || new ShopProductsRepository()
    // Build a ShopProductsService for stock-transition side effects so that
    // order-driven stock decrements (Req 11.1–11.4, 11.6, 11.9) emit the
    // same Socket.IO + push notifications as manual stock updates.
    this.shopProductsService =
      options.shopProductsService ||
      new ShopProductsService(this.shopProductsRepo, {
        notificationsService: fastify
          ? new NotificationsService(new NotificationsRepository(), fastify)
          : null,
      })
    // Canonical fee engine — shared by cart summary and order creation so
    // the charged total always matches the displayed bill.
    this.feeSettingsService =
      options.feeSettingsService || new FeeSettingsService()
    this.totalsEngine =
      options.totalsEngine ||
      new TotalsEngine({ feeSettingsService: this.feeSettingsService })
    this.orderSplitter =
      options.orderSplitter ||
      new OrderSplitterService({
        ordersRepository: this.repo,
        shopProductsRepository: this.shopProductsRepo,
        shopProductsService: this.shopProductsService,
        feeSettingsService: this.feeSettingsService,
        totalsEngine: this.totalsEngine,
        fees: {
          deliveryFee: DELIVERY_FEE,
          platformFee: PLATFORM_FEE,
          freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
        },
      })
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  /**
   * Place a multi-vendor order from the cart.
   *
   * Flow:
   *   1. Re-validate cart against current allocations + max_order_qty + stock
   *      (Requirements 12.3, 12.7). Any failure short-circuits with code
   *      CHECKOUT_PARTIAL_FAIL listing each `{ productId, shopId, reason }`.
   *   2. Validate the delivery address has coordinates.
   *   3. Open a single pg transaction.
   *   4. Delegate to OrderSplitter which:
   *        - groups items by vendor_id (Req 5.6)
   *        - locks vendor_services rows (SELECT FOR UPDATE) (Req 11.7)
   *        - re-checks max_order_qty + stock under the lock (Req 12.7)
   *        - decrements stock and inserts one order per shop with
   *          independently-computed fees (Req 5.7)
   *   5. COMMIT on success; ROLLBACK on any error (Req 5.9, 15.9, 15.10).
   *   6. Post-commit: clear cart + extras, enqueue per-order delivery
   *      assignments, and send customer notifications (Req 5.8).
   *
   * Coupons and tip are applied ONLY when the cart resolves to a single
   * shop. With multi-shop carts they are deferred to a later spec — applying
   * a single coupon code across multiple per-shop totals would require
   * platform-level coupon redistribution rules that are out of scope.
   */
  async placeOrder(userId, body) {
    const {
      addressId,
      paymentMethod,
      couponCode,
      deliveryNotes,
      tipAmount,
      deliveryInstructions,
      handlingFee,
      lateNightFee,
      savingsTotal,
      // Delivery slot fields
      deliveryMode,
      scheduledDeliveryAt,
      scheduledSlotStart,
      scheduledSlotEnd,
      scheduledSlotLabel,
      // Pickup slot fields for LNDRY
      vendorSlotId,
      pickupDate,
    } = body

    // Validate delivery slot
    const resolvedDeliveryMode = (deliveryMode || 'ASAP').toUpperCase()
    if (!['ASAP', 'SCHEDULED'].includes(resolvedDeliveryMode)) {
      return {
        success: false,
        message: 'deliveryMode must be ASAP or SCHEDULED',
        code: 'INVALID_DELIVERY_MODE',
      }
    }
    if (resolvedDeliveryMode === 'SCHEDULED') {
      if (!scheduledSlotStart || !scheduledSlotEnd) {
        return {
          success: false,
          message: 'scheduledSlotStart and scheduledSlotEnd are required for SCHEDULED delivery',
          code: 'MISSING_SLOT_FIELDS',
        }
      }
      const slotStart = new Date(scheduledSlotStart)
      const slotEnd = new Date(scheduledSlotEnd)
      const now = new Date()
      if (!Number.isFinite(slotStart.getTime()) || !Number.isFinite(slotEnd.getTime())) {
        return {
          success: false,
          message: 'scheduledSlotStart and scheduledSlotEnd must be valid ISO timestamps',
          code: 'INVALID_SLOT_TIMESTAMPS',
        }
      }
      if (slotStart <= now) {
        return {
          success: false,
          message: 'Scheduled delivery time must be in the future',
          code: 'SLOT_IN_PAST',
        }
      }
      if (slotEnd <= slotStart) {
        return {
          success: false,
          message: 'Slot end time must be after slot start time',
          code: 'INVALID_SLOT_RANGE',
        }
      }
      // Max 7 days ahead
      const maxAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      if (slotStart > maxAhead) {
        return {
          success: false,
          message: 'Scheduled delivery cannot be more than 7 days in the future',
          code: 'SLOT_TOO_FAR_AHEAD',
        }
      }
    }

    // 1. Validate cart (re-checks allocations, shop active, stock,
    //    max_order_qty per Req 12.3/12.7)
    const cartResult = await this.cartService.validateCart(userId)
    if (!cartResult.valid || cartResult.items.length === 0) {
      const failed = cartResult.failed && cartResult.failed.length > 0
        ? cartResult.failed
        : []
      const message = failed.length > 0
        ? 'Some items in your cart cannot be ordered right now'
        : (cartResult.warnings && cartResult.warnings[0]) || 'Cart is empty'
      return {
        success: false,
        message,
        code: failed.length > 0 ? 'CHECKOUT_PARTIAL_FAIL' : 'EMPTY_CART',
        failures: failed,
      }
    }

    const { items: cartItems, subtotal, groupedByShop } = cartResult

    // 2. Validate delivery address
    const address = await this.addressRepo.findByIdAndUser(addressId, userId)
    if (!address) {
      return { success: false, message: 'Delivery address not found', code: 'ADDRESS_NOT_FOUND' }
    }
    const addressLat = Number(address.lat)
    const addressLng = Number(address.lng)
    if (!Number.isFinite(addressLat) || !Number.isFinite(addressLng)) {
      return {
        success: false,
        message: 'Selected address is missing map pin. Please update address location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }
    const deliveryAddress = {
      ...address,
      lat: addressLat,
      lng: addressLng,
    }

    // 3. Apply coupon — only meaningful when the cart is single-shop. For
    //    multi-shop carts coupons are deferred (see method docstring).
    let appliedCouponCode = null
    let appliedCouponDiscount = 0
    let couponShopId = null
    if (couponCode) {
      const isSingleShop = groupedByShop.size === 1
      if (!isSingleShop) {
        return {
          success: false,
          message: 'Coupons are not yet supported for multi-shop carts',
          code: 'COUPON_MULTI_SHOP_UNSUPPORTED',
        }
      }
      const couponResult = await this.couponsService.validate(userId, couponCode, subtotal)
      if (!couponResult.valid) {
        return { success: false, message: couponResult.message, code: 'INVALID_COUPON' }
      }
      appliedCouponCode = couponResult.code
      // Capture the discount amount so it is actually deducted from the order
      // total (previously the code was stored but the discount was dropped).
      appliedCouponDiscount = Number(couponResult.discount || 0)
      couponShopId = Array.from(groupedByShop.keys())[0]
    }

    // 4. Resolve checkout extras (tip / instructions) — preserves the
    //    pre-multi-vendor behaviour for single-shop carts.
    const hasTipAmount = Object.prototype.hasOwnProperty.call(body, 'tipAmount')
    const normalizedInstructions = typeof deliveryInstructions === 'string'
      ? deliveryInstructions.trim()
      : deliveryInstructions
    const [tipFromRedis, instructionsFromRedis] = await Promise.all([
      hasTipAmount ? Promise.resolve(0) : this.cartRepo.getTip(userId),
      normalizedInstructions ? Promise.resolve(null) : this.cartRepo.getInstructions(userId),
    ])
    const orderTipAmount = hasTipAmount
      ? this._toNumber(tipAmount)
      : this._toNumber(tipFromRedis)
    const resolvedInstructions = normalizedInstructions || instructionsFromRedis || null

    const normalizedPaymentMethod = `${paymentMethod || 'COD'}`.toUpperCase()
    const initialPaymentStatus = 'PENDING'

    // Resolve shop coordinates for distance-based delivery fees (one query
    // for every shop in the cart). Used by the splitter's fee engine.
    const shopCoords = new Map()
    try {
      const shopIdList = Array.from(groupedByShop.keys())
      if (shopIdList.length > 0) {
        const { rows } = await query(
          `SELECT id, name, lat, lng FROM vendors WHERE id = ANY($1)`,
          [shopIdList]
        )
        for (const r of rows) {
          shopCoords.set(r.id, {
            name: r.name,
            lat: r.lat != null ? Number(r.lat) : NaN,
            lng: r.lng != null ? Number(r.lng) : NaN,
          })
        }
      }
    } catch (err) {
      logger.warn(
        { userId, err: err.message, action: 'order_shop_coords' },
        'Failed to resolve shop coordinates; delivery fee will use safe fallback'
      )
    }

    const feeContext = {
      deliveryCoords: { lat: addressLat, lng: addressLng },
      shopCoords,
      couponDiscount: appliedCouponDiscount,
      couponShopId,
      // Tip applies to a single order only (single-shop checkouts).
      tipAmount: orderTipAmount,
      tipShopId: groupedByShop.size === 1 ? Array.from(groupedByShop.keys())[0] : null,
    }

    // 5. Transaction: split + create orders + decrement stock atomically
    const client = await getClient()
    let createdOrders = []
    try {
      await client.query('BEGIN')

      // Enforce atomic slot capacity checking (locking the vendor slot via SELECT FOR UPDATE and verifying slot availability)
      const { rows: slotRows } = await client.query(
        `SELECT id, max_orders, vendor_id FROM vendor_slots WHERE id = $1 FOR UPDATE`,
        [vendorSlotId]
      )
      if (slotRows.length === 0) {
        throw { statusCode: 404, message: 'Pickup slot not found', code: 'SLOT_NOT_FOUND' }
      }
      const slot = slotRows[0]

      // Count other users' holds on this slot
      const { rows: holdRows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM slot_holds 
         WHERE slot_id = $1 AND booking_date = $2 AND expires_at > NOW() AND user_id != $3`,
        [vendorSlotId, pickupDate, userId]
      )
      // Count orders using this slot
      const { rows: orderRows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM orders 
         WHERE vendor_slot_id = $1 AND pickup_date = $2 AND status NOT IN ('PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')`,
        [vendorSlotId, pickupDate]
      )

      const activeBookings = (holdRows[0]?.count || 0) + (orderRows[0]?.count || 0)
      if (activeBookings >= slot.max_orders) {
        throw { statusCode: 409, message: 'Pickup slot is fully booked', code: 'SLOT_FULLY_BOOKED' }
      }

      // Delete this user's hold (atomically converting it)
      await client.query(
        `DELETE FROM slot_holds WHERE slot_id = $1 AND user_id = $2 AND booking_date = $3`,
        [vendorSlotId, userId, pickupDate]
      )

      const groups = this.orderSplitter.splitCart(cartItems)
      createdOrders = await this.orderSplitter.createOrders({
        client,
        userId,
        groups,
        deliveryAddress,
        payment: { method: normalizedPaymentMethod, status: initialPaymentStatus },
        feeContext,
        checkoutMeta: {
          couponCode: appliedCouponCode,
          deliveryNotes: deliveryNotes || null,
          deliveryInstructions: resolvedInstructions,
          // Delivery slot
          deliveryMode: resolvedDeliveryMode,
          scheduledDeliveryAt: resolvedDeliveryMode === 'SCHEDULED' ? (scheduledDeliveryAt || scheduledSlotStart) : null,
          scheduledSlotStart: resolvedDeliveryMode === 'SCHEDULED' ? scheduledSlotStart : null,
          scheduledSlotEnd: resolvedDeliveryMode === 'SCHEDULED' ? scheduledSlotEnd : null,
          scheduledSlotLabel: resolvedDeliveryMode === 'SCHEDULED' ? (scheduledSlotLabel || null) : null,
          // Pickup slot fields
          vendorSlotId,
          pickupDate,
        },
      })

      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      logger.error(
        {
          err: err.message,
          userId,
          code: err.code,
          failures: err.failures || null,
        },
        'Order placement failed; transaction rolled back'
      )
      if (err.code === 'CHECKOUT_PARTIAL_FAIL') {
        return {
          success: false,
          message: 'Some items in your cart cannot be ordered right now',
          code: 'CHECKOUT_PARTIAL_FAIL',
          failures: err.failures || [],
        }
      }
      return {
        success: false,
        message: err.message || 'Failed to place order',
        code: err.code || 'ORDER_FAILED',
      }
    } finally {
      client.release()
    }

    // 6. Post-commit cleanup + side effects (best-effort; do not fail the
    //    customer if any of these throw).
    try {
      // For ONLINE and WALLET payments, do NOT clear cart yet — cart is only
      // cleared after successful payment verification / wallet deduction.
      // This prevents the "cart disappeared but payment failed" bug.
      if (normalizedPaymentMethod !== 'ONLINE' && normalizedPaymentMethod !== 'WALLET') {
        await this.cartService.clearCart(userId)
      }
      if (appliedCouponCode && createdOrders.length === 1) {
        await this.couponsService.recordUsage(
          appliedCouponCode,
          userId,
          createdOrders[0].id
        )
      }
    } catch (err) {
      logger.warn(
        { err: err.message, userId, orderIds: createdOrders.map((o) => o.id) },
        'Post-order cleanup partial failure'
      )
    }

    // Stock-transition side effects (Req 11.1–11.4, 11.6, 11.9). Fired AFTER
    // COMMIT so a rolled-back checkout never emits user-facing events.
    // Already wrapped in a try/catch inside the splitter, but we add an
    // outer guard here to defend against an exception escaping the helper.
    try {
      const transitions = createdOrders.stockTransitions || []
      await this.orderSplitter.firePostCommitSideEffects(transitions)
    } catch (err) {
      logger.warn(
        {
          err: err.message,
          userId,
          orderIds: createdOrders.map((o) => o.id),
          action: 'order_stock_transitions_fan_out',
        },
        'Order-driven stock transition fan-out failed'
      )
    }

    // Per-order delivery assignment + notifications (Req 5.8)
    for (const order of createdOrders) {
      logger.info(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          shopId: order.shopId,
          userId,
          total: order.totalAmount,
          paymentMethod: normalizedPaymentMethod,
          status: order.status,
          action: 'order_placed',
        },
        'Per-shop order placed successfully'
      )

      // For ONLINE and WALLET payments, do NOT send "Order placed" notification yet.
      // - ONLINE: notification sent after Razorpay payment verification
      // - WALLET: notification sent after wallet deduction succeeds
      // This prevents false "Order placed" notifications when payment fails.
      if (normalizedPaymentMethod !== 'ONLINE' && normalizedPaymentMethod !== 'WALLET') {
        await this._sendCustomerOrderNotification(
          userId,
          buildCustomerOrderEventNotification({
            orderId: order.id,
            orderNumber: order.orderNumber,
            timelineType: 'ORDER_PLACED',
            status: order.status,
          })
        )
        // Queue auto-reject job for COD orders immediately
        await this._queueAutoReject(order.id)
      }
    }

    // Apply delivery instructions only. Tip + all fees (handling/platform/
    // delivery/coupon discount/savings) are computed authoritatively by the
    // fee engine at order-creation time and persisted in the transaction, so
    // we must NOT overwrite them here from the client request body.
    if (createdOrders.length === 1 && resolvedInstructions) {
      try {
        await this.repo.updateExtras(createdOrders[0].id, {
          deliveryInstructions: resolvedInstructions,
        })
      } catch (err) {
        logger.warn(
          { err: err.message, orderId: createdOrders[0].id },
          'Failed to update order extras (non-critical)'
        )
      }
    }

    // Backwards-compatible response shape: callers that expect a single
    // `order` field still get the first order; new clients should read the
    // `orders` array.
    return {
      success: true,
      orders: createdOrders,
      order: createdOrders[0],
    }
  }

  _toNumber(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  /**
   * List orders for the current user (paginated)
   */
  async listByUser(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { orders, total } = await this.repo.findByUser(userId, {
      limit,
      offset,
      status: filters.status,
    })

    return {
      orders: await this._attachItemThumbnails(orders),
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Get active (in-progress) order for a user
   */
  async getActive(userId) {
    const order = await this.repo.findActiveByUser(userId)
    if (!order) {
      return null
    }
    return this._enrichCustomerOrder(order)
  }

  /**
   * Get a single order by ID (user-scoped)
   */
  async getById(userId, orderId) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return null
    }
    return this._enrichCustomerOrder(order)
  }

  /**
   * Cancel an order (only if PENDING or CONFIRMED)
   */
  async cancel(userId, orderId, reason) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const cancellable = [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED]
    if (!cancellable.includes(order.status)) {
      return {
        success: false,
        message: `Cannot cancel order in "${order.status}" status`,
      }
    }

    // Restore stock in a transaction
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.repo.restoreStock(client, order.items)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, orderId }, 'Stock restore failed during cancellation')
    } finally {
      client.release()
    }

    const updated = await this.repo.updateStatus(orderId, ORDER_STATUS.CANCELLED, {
      cancelledReason: reason || 'Cancelled by customer',
    })

    logger.info({ orderId, userId }, 'Order cancelled')
    return { success: true, order: updated }
  }

  /**
   * Re-order: add items from a past order back to cart
   */
  async reorder(userId, orderId) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const warnings = []

    for (const item of order.items) {
      const result = await this.cartService.addItem(userId, {
        productId: item.productId,
        shopId: item.shopId || order.shopId || null,
        quantity: item.quantity,
      })
      if (!result.success) {
        warnings.push(result.message)
      }
    }

    const cart = await this.cartService.getCart(userId)

    return {
      success: true,
      cart,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  // ─── Admin methods ─────────────────────────────────────

  /**
   * Admin: list all orders (paginated, filterable)
   */
  async adminListAll(filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { orders, total } = await this.repo.findAll({
      limit,
      offset,
      status: filters.status,
      userId: filters.userId,
    })

    return {
      orders,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: update order status
   */
  async adminUpdateStatus(orderId, status) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const extra = {}
    if (status === ORDER_STATUS.DELIVERED) {
      extra.deliveredAt = new Date()
      extra.paymentStatus = 'PAID'
    }
    if (status === ORDER_STATUS.CANCELLED) {
      extra.cancelledReason = 'Cancelled by admin'
      // Restore stock
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await this.repo.restoreStock(client, order.items)
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error({ err, orderId }, 'Stock restore failed during admin cancellation')
      } finally {
        client.release()
      }
    }

    const updated = await this.repo.updateStatus(orderId, status, extra)
    logger.info({ orderId, status }, 'Order status updated by admin')
    return { success: true, order: updated }
  }

  /**
   * Admin: assign a rider to an order
   */
  async adminAssignRider(orderId, riderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED) {
      return { success: false, message: 'Cannot assign rider to a completed/cancelled order' }
    }

    const updated = await this.repo.assignRider(orderId, riderId)
    logger.info({ orderId, riderId }, 'Rider assigned to order')
    return { success: true, order: updated }
  }

  /**
   * Generate PDF invoice for an order
   */
  async getInvoice(userId, orderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, statusCode: 404, message: 'Order not found' }
    }

    // Customers can only access their own invoices
    if (order.user_id !== userId) {
      return { success: false, statusCode: 403, message: 'Access denied' }
    }

    if (order.payment_status !== 'PAID') {
      return { success: false, statusCode: 400, message: 'Invoice available only for paid orders' }
    }

    const buffer = await generateInvoicePDF(order)
    return {
      success: true,
      buffer,
      orderNumber: order.order_number,
    }
  }

  async _queueAutoReject(orderId) {
    try {
      await orderQueue.add(
        'auto-reject',
        {
          type: 'auto-reject',
          orderId,
        },
        {
          jobId: `auto-reject-${orderId}`,
          delay: 15 * 60 * 1000,
          removeOnComplete: true,
        }
      )
      logger.info({ orderId }, 'Auto-reject job queued')
    } catch (err) {
      logger.warn({ err, orderId }, 'Failed to queue auto-reject job')
    }
  }

  async _queueAutoAssign(orderId, source = 'ORDERS_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        {
          type: 'auto-assign',
          orderId,
          source,
        },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }

  async _enrichCustomerOrder(order) {
    const [statusHistory, riderLocation] = await Promise.all([
      this.repo.getStatusHistory(order.id),
      order.riderId && this.fastify?.getRiderLocation
        ? this.fastify.getRiderLocation(order.riderId).catch(() => null)
        : Promise.resolve(null),
    ])

    const [enriched] = await this._attachItemThumbnails([order])

    return {
      ...enriched,
      timeline: this._buildCustomerTimeline(order, statusHistory || []),
      tracking: this._buildTrackingData(order, riderLocation),
    }
  }

  /**
   * Enrich denormalized order items with the current product thumbnail.
   *
   * Order items are point-in-time snapshots without an image, so customer
   * order screens look thin. We batch-resolve thumbnails for every item across
   * all supplied orders in a single query (no N+1) and attach `thumbnailUrl`.
   * Failures are swallowed — a missing image must never break the orders list.
   *
   * @param {Array<object>} orders
   * @returns {Promise<Array<object>>}
   */
  async _attachItemThumbnails(orders) {
    if (!Array.isArray(orders) || orders.length === 0) {
      return orders || []
    }

    try {
      const productIds = []
      for (const order of orders) {
        for (const item of order.items || []) {
          if (item && item.productId) {
            productIds.push(item.productId)
          }
        }
      }

      if (productIds.length === 0) {
        return orders
      }

      const thumbnailMap = await this.repo.findThumbnailsByProductIds(productIds)

      return orders.map((order) => ({
        ...order,
        items: (order.items || []).map((item) => {
          const raw = thumbnailMap.get(item.productId) || null
          return {
            ...item,
            thumbnailUrl: raw
              ? normalizeCloudinaryDeliveryUrl(raw, 'thumb')
              : null,
          }
        }),
      }))
    } catch (err) {
      logger.warn(
        { err: err.message, action: 'attach_item_thumbnails' },
        'Failed to enrich order items with thumbnails'
      )
      return orders
    }
  }

  _buildCustomerTimeline(order, statusHistory) {
    const timeline = [
      {
        type: 'PENDING',
        status: 'PENDING',
        message: 'Order placed',
        timestamp: order.createdAt,
      },
    ]
    const seenTypes = new Set(['PENDING'])

    for (const entry of statusHistory) {
      const timelineType = this._normalizeTimelineType(entry.to_status)
      if (!timelineType || seenTypes.has(timelineType)) {
        continue
      }

      timeline.push({
        type: timelineType,
        status: this._timelineTypeToOrderStatus(timelineType),
        message: entry.note || this._timelineMessage(timelineType),
        timestamp: entry.changed_at,
      })
      seenTypes.add(timelineType)
    }

    const currentTimelineType = this._normalizeTimelineType(order.status)
    if (currentTimelineType && !seenTypes.has(currentTimelineType)) {
      timeline.push({
        type: currentTimelineType,
        status: this._timelineTypeToOrderStatus(currentTimelineType),
        message: this._timelineMessage(currentTimelineType),
        timestamp: order.deliveredAt || order.updatedAt || order.createdAt,
      })
    }

    return timeline.sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime()
      const rightTime = new Date(right.timestamp).getTime()
      return leftTime - rightTime
    })
  }

  _buildTrackingData(order, riderLocation) {
    const address = order.deliveryAddress || {}
    const destinationLat = Number(address.lat)
    const destinationLng = Number(address.lng)
    const riderLat = Number(riderLocation?.lat)
    const riderLng = Number(riderLocation?.lng)

    return {
      rider: order.riderId
        ? {
            id: order.riderId,
            name: order.riderName || 'Delivery partner',
            phone: order.riderPhone || '',
          }
        : null,
      riderLocation:
        Number.isFinite(riderLat) && Number.isFinite(riderLng)
          ? {
              lat: riderLat,
              lng: riderLng,
              timestamp: riderLocation?.updatedAt
                ? new Date(riderLocation.updatedAt).toISOString()
                : null,
            }
          : null,
      destination: {
        lat: Number.isFinite(destinationLat) ? destinationLat : null,
        lng: Number.isFinite(destinationLng) ? destinationLng : null,
        addressLine1: address.addressLine1 || address.address_line1 || '',
        addressLine2: address.addressLine2 || address.address_line2 || '',
        landmark: address.landmark || '',
        city: address.city || '',
        state: address.state || '',
        pincode: address.pincode || '',
      },
    }
  }

  _normalizeTimelineType(rawStatus) {
    const normalized = `${rawStatus || ''}`.trim().toUpperCase()
    if (!normalized) {
      return null
    }

    if (normalized === 'IN_TRANSIT') {
      return 'OUT_FOR_DELIVERY'
    }

    return normalized
  }

  _timelineTypeToOrderStatus(timelineType) {
    switch (timelineType) {
      case 'RIDER_ACCEPTED':
        return 'PACKED'
      case 'PICKED_UP':
      case 'OUT_FOR_DELIVERY':
        return 'OUT_FOR_DELIVERY'
      default:
        return timelineType
    }
  }

  _timelineMessage(timelineType) {
    switch (timelineType) {
      case 'PENDING':
        return 'Order placed'
      case 'CONFIRMED':
        return 'Store accepted your order'
      case 'PREPARING':
        return 'Store is preparing your order'
      case 'PACKED':
        return 'Order packed and ready for pickup'
      case 'RIDER_ACCEPTED':
        return 'Delivery partner accepted your order'
      case 'PICKED_UP':
        return 'Delivery partner picked up your order'
      case 'OUT_FOR_DELIVERY':
        return 'Your order is out for delivery'
      case 'DELIVERED':
        return 'Order delivered successfully'
      case 'CANCELLED':
        return 'Order cancelled'
      default:
        return 'Order updated'
    }
  }

  async _sendCustomerOrderNotification(userId, notification) {
    if (!this.notificationsService || !userId || !notification) {
      return
    }

    try {
      await this.notificationsService.sendNotification(userId, notification)
    } catch (err) {
      logger.warn(
        {
          err: err.message,
          userId,
          orderId: notification?.data?.orderId ?? null,
          timelineType: notification?.data?.timelineType ?? null,
        },
        'Customer order notification failed'
      )
    }
  }

  _paiseToRupees(paise) {
    return Number((Number(paise) / 100).toFixed(2))
  }

  _rupeesToPaise(rupees) {
    return Math.round(Number(rupees) * 100)
  }

  _assertFeeBreakdownConsistency(feeBreakdown) {
    const subtotal = Number(feeBreakdown.subtotal_paise || 0)
    const deliveryFee = Number(feeBreakdown.delivery_fee_paise || 0)
    const platformFee = Number(feeBreakdown.platform_fee_paise || 0)
    const tax = Number(feeBreakdown.tax_paise || 0)
    const discount = Number(feeBreakdown.discount_paise || 0)
    const totalPayable = Number(feeBreakdown.total_payable_paise || 0)
    const expected = subtotal + deliveryFee + platformFee + tax - discount

    if (expected !== totalPayable) {
      throw {
        statusCode: 500,
        message: 'Checkout pricing breakdown is internally inconsistent',
        code: 'PRICING_BREAKDOWN_MISMATCH'
      }
    }
  }

  async _buildDraftFeeBreakdown({ quote, vendor, distanceKm, couponDiscount = 0 }) {
    const subtotalPaise = Number(quote.estimate_paise || 0)
    const subtotalRupees = this._paiseToRupees(subtotalPaise)
    const { config, source } = await this.feeSettingsService.resolveForShop(quote.vendor_id)
    const canonical = this.totalsEngine.computeBreakdown({
      config,
      itemsSubtotal: subtotalRupees,
      couponDiscount,
      distanceKm: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : null,
      tax: 0,
      tipAmount: 0,
      storeName: vendor?.business_name || vendor?.name || null,
    })

    const deliveryFeePaise = this._rupeesToPaise(canonical.deliveryFee)
    const platformFeePaise = this._rupeesToPaise(
      Number(canonical.platformFee || 0) +
        Number(canonical.handlingFee || 0) +
        Number(canonical.smallCartFee || 0) +
        Number(canonical.surgeFee || 0) +
        Number(canonical.packagingFee || 0)
    )
    const taxPaise = this._rupeesToPaise(canonical.tax)
    const discountPaise = this._rupeesToPaise(canonical.couponDiscount)
    const totalPayablePaise =
      subtotalPaise + deliveryFeePaise + platformFeePaise + taxPaise - discountPaise

    const feeBreakdown = {
      subtotal_paise: subtotalPaise,
      delivery_fee_paise: deliveryFeePaise,
      platform_fee_paise: platformFeePaise,
      tax_paise: taxPaise,
      discount_paise: discountPaise,
      total_payable_paise: totalPayablePaise,
      pricing_source: source,
      canonical_breakdown: canonical,
    }
    this._assertFeeBreakdownConsistency(feeBreakdown)
    return feeBreakdown
  }

  _normalizeDraftFeeBreakdown(rawFeeBreakdown) {
    if (!rawFeeBreakdown) {
      throw {
        statusCode: 409,
        message: 'Order draft is missing backend pricing breakdown. Please restart checkout.',
        code: 'DRAFT_PRICING_MISSING'
      }
    }

    const parsed =
      typeof rawFeeBreakdown === 'string'
        ? JSON.parse(rawFeeBreakdown)
        : rawFeeBreakdown
    const feeBreakdown = {
      ...parsed,
      subtotal_paise: Number(parsed.subtotal_paise || 0),
      delivery_fee_paise: Number(parsed.delivery_fee_paise || 0),
      platform_fee_paise: Number(parsed.platform_fee_paise || 0),
      tax_paise: Number(parsed.tax_paise || 0),
      discount_paise: Number(parsed.discount_paise || 0),
      total_payable_paise: Number(parsed.total_payable_paise || 0),
    }
    this._assertFeeBreakdownConsistency(feeBreakdown)
    return feeBreakdown
  }

  async prepareOrder(userId, body) {
    const quoteId = body.quoteId || body.quote_id
    const addressId = body.addressId || body.address_id
    const slotId = body.slotId || body.slot_id
    const couponCode = body.couponCode || body.coupon_code

    // 1. Fetch quote from Postgres and verify ownership
    const quoteRes = await query(
      `SELECT * FROM quotes WHERE id = $1`,
      [quoteId]
    )
    if (quoteRes.rows.length === 0) {
      return { success: false, message: 'Quotation not found or expired', code: 'QUOTE_EXPIRED' }
    }
    const dbQuote = quoteRes.rows[0]
    if (dbQuote.customer_id !== userId) {
      return { success: false, message: 'Forbidden - you do not own this quotation', code: 'FORBIDDEN' }
    }
    if (new Date(dbQuote.expires_at) < new Date()) {
      return { success: false, message: 'Quotation has expired', code: 'QUOTE_EXPIRED' }
    }

    const quote = {
      quote_id: quoteId,
      vendor_id: dbQuote.vendor_id,
      estimate_paise: dbQuote.estimate_paise,
      garment_lines: typeof dbQuote.pricing_snapshot === 'string' ? JSON.parse(dbQuote.pricing_snapshot) : dbQuote.pricing_snapshot,
      estimated_weight_kg: dbQuote.estimated_weight_kg ? Number(dbQuote.estimated_weight_kg) : null
    }

    // 2. Fetch address
    const address = await this.addressRepo.findByIdAndUser(addressId, userId)
    if (!address) {
      return { success: false, message: 'Delivery address not found', code: 'ADDRESS_NOT_FOUND' }
    }

    // 3. Verify vendor status & approved service radius eligibility (Haversine check)
    const vendorRes = await query(
      `SELECT id, is_active, status, lat, lng, approved_service_radius_km, vendor_approved, account_enabled, marketplace_published
       FROM vendors
       WHERE id = $1 AND deleted_at IS NULL`,
      [quote.vendor_id]
    )
    const vendor = vendorRes.rows[0]
    if (!vendor || !vendor.is_active || vendor.status !== 'APPROVED' || !vendor.vendor_approved || !vendor.account_enabled || !vendor.marketplace_published) {
      return { success: false, message: 'Vendor is not available for service', code: 'VENDOR_UNAVAILABLE' }
    }

    // Check Haversine distance
    const EARTH_RADIUS_KM = 6371
    const { rows: distRows } = await query(
      `SELECT (${EARTH_RADIUS_KM} * acos(
         LEAST(1.0, GREATEST(-1.0,
           cos(radians($1::float8)) * cos(radians($2::float8))
             * cos(radians($3::float8) - radians($4::float8))
             + sin(radians($1::float8)) * sin(radians($2::float8))
         ))
       ))::numeric(7,2) AS distance_km`,
      [Number(address.lat), Number(vendor.lat), Number(address.lng), Number(vendor.lng)]
    )
    const distance = parseFloat(distRows[0]?.distance_km || 0)
    if (distance > parseFloat(vendor.approved_service_radius_km)) {
      return { success: false, message: 'Address falls outside this vendor\'s service area', code: 'OUT_OF_RADIUS' }
    }

    // 4. Verify slot hold ownership (must match the user and the quote)
    const holdRes = await query(
      `SELECT booking_date FROM slot_holds
       WHERE customer_id = $1 AND slot_id = $2 AND vendor_id = $3 AND quote_id = $4 AND expires_at > NOW()
       LIMIT 1`,
      [userId, slotId, quote.vendor_id, quoteId]
    )
    if (holdRes.rows.length === 0) {
      return { success: false, message: 'No active slot hold found. Please hold a pickup slot before checkout.', code: 'NO_SLOT_HOLD' }
    }
    const bookingDate = holdRes.rows[0].booking_date

    // 4b. Validate coupon (if provided) against this quote's subtotal —
    // single-vendor drafts only, so no multi-shop redistribution needed here.
    let appliedCouponCode = null
    let appliedCouponDiscount = 0
    if (couponCode) {
      const subtotalRupees = this._paiseToRupees(quote.estimate_paise)
      const couponResult = await this.couponsService.validate(userId, couponCode, subtotalRupees)
      if (!couponResult.valid) {
        return { success: false, message: couponResult.message, code: 'INVALID_COUPON' }
      }
      appliedCouponCode = couponResult.code
      appliedCouponDiscount = Number(couponResult.discount || 0)
    }

    // 5. Canonical backend pricing. Quote owns item pricing; TotalsEngine owns
    // fees/taxes/discount math so draft and final order use the same snapshot.
    const feeBreakdown = await this._buildDraftFeeBreakdown({
      quote,
      vendor,
      distanceKm: distance,
      couponDiscount: appliedCouponDiscount,
    })
    const payableAmount = feeBreakdown.total_payable_paise

    const snapshot = {
      quote,
      address,
      slot_id: slotId,
      booking_date: bookingDate,
      fee_breakdown: feeBreakdown,
      coupon_code: appliedCouponCode
    }

    // 6. Write draft
    const { rows: draftRows } = await query(
      `INSERT INTO order_drafts (user_id, vendor_id, slot_id, address_id, garment_lines, estimated_weight, payable_amount_paise, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        quote.vendor_id,
        slotId,
        addressId,
        JSON.stringify(quote.garment_lines),
        quote.estimated_weight_kg ? Number(quote.estimated_weight_kg) : null,
        payableAmount,
        JSON.stringify(snapshot)
      ]
    )

    return {
      success: true,
      data: {
        order_draft_id: draftRows[0].id,
        payable_amount_paise: payableAmount,
        snapshot
      }
    }
  }

  async placeOrderFromDraft(userId, body) {
    const orderDraftId = body.orderDraftId || body.order_draft_id
    const resolvedPaymentMethod = (body.paymentMethod || body.payment_method || 'ONLINE').toUpperCase()
    const isCod = resolvedPaymentMethod === 'COD'

    // Check if order already exists for this draft ID (idempotency check)
    const existingOrderRes = await query('SELECT * FROM orders WHERE id = $1', [orderDraftId])
    if (existingOrderRes.rows.length > 0) {
      return {
        success: true,
        order: existingOrderRes.rows[0],
        status: existingOrderRes.rows[0].status
      }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      // 1. Lock draft FOR UPDATE
      const draftRes = await client.query('SELECT * FROM order_drafts WHERE id = $1 AND user_id = $2 FOR UPDATE', [orderDraftId, userId])
      const draft = draftRes.rows[0]
      if (!draft) {
        throw { statusCode: 404, message: 'Order draft not found', code: 'DRAFT_NOT_FOUND' }
      }

      // 2. Lock payment FOR UPDATE — skipped for COD, which is paid on delivery
      // rather than upfront, so there's no payments row to require yet.
      let payment = null
      if (!isCod) {
        const paymentRes = await client.query('SELECT * FROM payments WHERE order_draft_id = $1 AND status = \'PAID\' FOR UPDATE', [orderDraftId])
        payment = paymentRes.rows[0]
        if (!payment) {
          throw { statusCode: 400, message: 'Payment not verified. Please complete payment first.', code: 'PAYMENT_PENDING' }
        }
      }

      const snapshot = typeof draft.snapshot === 'string' ? JSON.parse(draft.snapshot) : draft.snapshot
      const quoteId = snapshot.quote?.quote_id || snapshot.quote?.id

      // 3. Lock slot hold FOR UPDATE
      const holdRes = await client.query(
        'SELECT * FROM slot_holds WHERE customer_id = $1 AND slot_id = $2 AND vendor_id = $3 AND quote_id = $4 AND status = \'ACTIVE\' AND expires_at > NOW() FOR UPDATE',
        [userId, draft.slot_id, draft.vendor_id, quoteId]
      )
      const hold = holdRes.rows[0]
      if (!hold) {
        throw { statusCode: 400, message: 'Pickup slot hold has expired or is invalid. Please request a new slot.', code: 'HOLD_EXPIRED' }
      }

      // 4. Lock vendor slot FOR UPDATE
      const slotRes = await client.query(
        'SELECT id, max_orders FROM vendor_slots WHERE id = $1 FOR UPDATE',
        [draft.slot_id]
      )
      if (slotRes.rows.length === 0) {
        throw { statusCode: 404, message: 'Vendor slot not found' }
      }
      const slot = slotRes.rows[0]

      // 5. Enforce slot capacity under lock (exclude our locked hold)
      const committedOrdersRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM orders 
         WHERE vendor_slot_id = $1 AND pickup_date = $2 AND status NOT IN ('PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED')`,
        [draft.slot_id, snapshot.booking_date]
      )
      const activeHoldsRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM slot_holds 
         WHERE slot_id = $1 AND booking_date = $2 AND expires_at > NOW() AND status = 'ACTIVE' AND id != $3`,
        [draft.slot_id, snapshot.booking_date, hold.id]
      )
      
      const totalBooked = (committedOrdersRes.rows[0]?.count || 0) + (activeHoldsRes.rows[0]?.count || 0)
      if (totalBooked >= slot.max_orders) {
        throw { statusCode: 409, message: 'Selected pickup slot is fully booked', code: 'SLOT_FULL' }
      }

      // 6. Generate collision-free order number LNDR-YYYYMMDD-RAND
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const randSuffix = Math.random().toString(36).substring(2, 5).toUpperCase()
      const orderNumber = `LNDR-${today}-${randSuffix}`

      const feeBreakdown = this._normalizeDraftFeeBreakdown(snapshot.fee_breakdown)
      const subtotalRupees = this._paiseToRupees(feeBreakdown.subtotal_paise)
      const deliveryFeeRupees = this._paiseToRupees(feeBreakdown.delivery_fee_paise)
      const platformFeeRupees = this._paiseToRupees(feeBreakdown.platform_fee_paise)
      const taxRupees = this._paiseToRupees(feeBreakdown.tax_paise)
      const discountRupees = this._paiseToRupees(feeBreakdown.discount_paise)
      const totalRupees = this._paiseToRupees(feeBreakdown.total_payable_paise)

      const appliedCouponCode = snapshot.coupon_code || null

      // 7. Insert the order
      const orderInsertRes = await client.query(
        `INSERT INTO orders (
           id, order_number, user_id, vendor_id, status, items, subtotal, discount_amount,
           delivery_fee, platform_fee, tax_amount, total_amount,
           payment_method, payment_status, delivery_address,
           vendor_slot_id, pickup_date,
           estimated_amount_paise, payable_amount_paise,
           fee_breakdown, coupon_code
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         RETURNING id, order_number, user_id, vendor_id, status, created_at`,
        [
          orderDraftId,
          orderNumber,
          userId,
          draft.vendor_id,
          'WAITING_VENDOR_CONFIRMATION',
          JSON.stringify(draft.garment_lines),
          subtotalRupees,
          discountRupees,
          deliveryFeeRupees,
          platformFeeRupees,
          taxRupees,
          totalRupees,
          isCod ? 'COD' : 'ONLINE',
          isCod ? 'PENDING' : 'PAID',
          JSON.stringify(snapshot.address),
          draft.slot_id,
          snapshot.booking_date,
          feeBreakdown.subtotal_paise,
          feeBreakdown.total_payable_paise,
          JSON.stringify(feeBreakdown),
          appliedCouponCode
        ]
      )
      const order = orderInsertRes.rows[0]

      // 8. Insert garment lines into order_lines
      for (const line of draft.garment_lines) {
        await client.query(
          `INSERT INTO order_lines (
             order_id, garment_type_id, name, price, quantity, unit, total, vendor_id,
             estimated_quantity, rate_paise, total_paise
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            order.id,
            line.garment_type_id,
            line.name,
            line.rate_paise / 100,
            line.quantity,
            line.unit,
            line.total_paise / 100,
            draft.vendor_id,
            line.quantity,
            line.rate_paise,
            line.total_paise
          ]
        )
      }

      // 9. Record Order Event
      const { recordOrderEvent } = await import('../../utils/state-machine.js')
      await recordOrderEvent(client, {
        orderId: order.id,
        oldStatus: null,
        newStatus: 'WAITING_VENDOR_CONFIRMATION',
        actorId: userId,
        actorRole: 'CUSTOMER',
        note: 'Order placed from draft'
      })

      // 10. Link payment (if any — COD has none yet) and consume hold
      if (payment) {
        await client.query('UPDATE payments SET order_id = $1 WHERE id = $2', [order.id, payment.id])
      }
      await client.query('UPDATE slot_holds SET status = \'CONSUMED\' WHERE id = $1', [hold.id])

      await client.query('COMMIT')

      if (appliedCouponCode) {
        try {
          await this.couponsService.recordUsage(appliedCouponCode, userId, order.id)
        } catch (err) {
          logger.warn({ err: err.message, orderId: order.id }, 'Coupon usage recording failed')
        }
      }

      // Notify vendor
      try {
        if (this.fastify?.io) {
          this.fastify.io.to(`shop:${draft.vendor_id}`).emit('order.created', {
            order_id: order.id,
            status: 'WAITING_VENDOR_CONFIRMATION',
            order_number: orderNumber
          })
        }
      } catch (err) {
        logger.warn({ err: err.message, orderId: order.id }, 'Realtime notification failed')
      }

      return {
        success: true,
        order,
        status: 'WAITING_VENDOR_CONFIRMATION'
      }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err: err.message, draftId: orderDraftId }, 'Order draft checkout failed')
      throw err
    } finally {
      client.release()
    }
  }
}
