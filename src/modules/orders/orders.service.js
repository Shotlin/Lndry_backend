import { getClient } from '../../config/database.js'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ORDER_STATUS, ACTIVE_ORDER_STATUSES } from '../../constants/orderStatus.js'
import { ORDER_STATUSES, validateTransition, recordOrderEvent } from '../../utils/state-machine.js'
import { InvoicesService, InvoiceError } from '../invoices/invoices.service.js'
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
import { FirstTimeOffersRepository } from '../admin/first-time-offers/first-time-offers.repository.js'
import { FirstTimeOffersService } from '../admin/first-time-offers/first-time-offers.service.js'
import { CartMilestonesRepository } from '../admin/cart-milestones/cart-milestones.repository.js'
import { CartMilestonesService } from '../admin/cart-milestones/cart-milestones.service.js'
import { ReferralsRepository } from '../referrals/referrals.repository.js'
import { ReferralsService } from '../referrals/referrals.service.js'
import { ShopProductsRepository } from '../shop-garment_rates/shop-garment_rates.repository.js'
import { ShopProductsService } from '../shop-garment_rates/shop-garment_rates.service.js'
import { OrderSplitterService } from './order-splitter.service.js'
import { prepareReorder } from './reorder.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from '../../../archived_modules/cart/totals-engine.service.js'
import { emitLifecycleEvent } from '../lifecycle-notifications/lifecycle-jobs.js'

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
    this.firstTimeOffersRepo =
      options.firstTimeOffersRepository || new FirstTimeOffersRepository()
    this.firstTimeOffersService =
      options.firstTimeOffersService || new FirstTimeOffersService(this.firstTimeOffersRepo, this.couponsRepo)
    this.cartMilestonesRepo =
      options.cartMilestonesRepository || new CartMilestonesRepository()
    this.cartMilestonesService =
      options.cartMilestonesService || new CartMilestonesService(this.cartMilestonesRepo, undefined, this.couponsRepo)
    this.referralsRepo =
      options.referralsRepository || new ReferralsRepository()
    this.referralsService =
      options.referralsService || new ReferralsService(this.referralsRepo)
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
        // Customer + laundry notifications (idempotent: a second call is a no-op).
        await emitLifecycleEvent('ORDER_PLACED', { orderId: order.id })
        await emitLifecycleEvent('VENDOR_NEW_ORDER', { orderId: order.id })
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
  /**
   * Prepares a reorder from a past order — see reorder.service.js. Nothing is
   * written; the app puts the returned items in the cart and the customer
   * reviews and checks out as usual.
   */
  async reorder(userId, orderId) {
    return prepareReorder(userId, orderId)
  }

  // ─── Order reconciliation (customer accept/reject) ─────

  /**
   * The reconciliation currently awaiting this customer's decision, if any
   * — with its photo evidence. Returns null (not a 404) when nothing is
   * pending, since "no pending reconciliation" is a normal order state.
   */
  async getReconciliation(userId, orderId) {
    const orderRes = await query(`SELECT id FROM orders WHERE id = $1 AND user_id = $2`, [orderId, userId])
    if (!orderRes.rows[0]) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

    const reconRes = await query(
      `SELECT * FROM order_reconciliations
       WHERE order_id = $1 AND status = 'PENDING_CUSTOMER'
       ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    )
    const reconciliation = reconRes.rows[0]
    if (!reconciliation) return null

    return this._attachReconciliationPhotos(reconciliation)
  }

  /**
   * Customer accepts the vendor's proposed recalculation. Applies the
   * already-computed proposed numbers verbatim (never a fresh recompute) so
   * what gets applied can never drift from what the customer actually
   * reviewed in `getReconciliation`.
   */
  async acceptReconciliation(userId, orderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const orderRes = await client.query(
        `SELECT id, status, user_id, fee_breakdown FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [orderId, userId]
      )
      const order = orderRes.rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      const reconRes = await client.query(
        `SELECT * FROM order_reconciliations WHERE order_id = $1 AND status = 'PENDING_CUSTOMER' FOR UPDATE`,
        [orderId]
      )
      const reconciliation = reconRes.rows[0]
      if (!reconciliation) throw { statusCode: 404, message: 'No reconciliation awaiting your approval', code: 'RECONCILIATION_NOT_FOUND' }

      const transition = validateTransition(order.status, ORDER_STATUSES.PROCESSING, 'CUSTOMER')
      if (!transition.valid) throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }

      const lineChanges = typeof reconciliation.line_changes === 'string'
        ? JSON.parse(reconciliation.line_changes)
        : (reconciliation.line_changes || [])

      for (const change of lineChanges) {
        // garment_type_id/name/unit/rate_paise are always set from the
        // proposed_* values — a no-op for non-reclassified lines (proposed
        // equals previous there), but the mechanism that actually moves a
        // line to a different service for reclassified ones. A continuous-
        // unit line (kg/sqft) stores the sentinel confirmed_quantity=1 since
        // the INTEGER column can't hold its real decimal weight/area — the
        // exact money value in total_paise (and order_reconciliations.
        // proposed_weight_kg) is what both apps derive the true decimal
        // display from. Each paise value is passed twice (once plain, once
        // for the ::numeric cast) rather than reused by placeholder number —
        // reusing one $N in both a plain-integer context and an explicit
        // ::numeric cast leaves Postgres unable to settle on a single type
        // for it, throwing 42P08 "indeterminate_datatype".
        if (change.is_new) {
          // A service that wasn't on the order at all — either a genuine
          // addition, or the destination for a partial quantity moved out
          // of an existing continuous-unit line. Didn't exist as an
          // order_lines row until now (staged only in this reconciliation's
          // line_changes JSON since proposeReconciliation), so this is an
          // INSERT, not an UPDATE. Same INTEGER-column sentinel as the
          // weight-adjustment branch applies if this new line is itself
          // continuous-unit.
          const storedQuantity = change.is_weight_adjustment ? 1 : change.proposed_quantity
          await client.query(
            `INSERT INTO order_lines (
               order_id, garment_type_id, name, unit, rate_paise,
               estimated_quantity, confirmed_quantity, quantity, price, total_paise, total
             ) VALUES ($1, $2, $3, $4, $5, $6, $6, $6, ($7::numeric / 100), $8, ($9::numeric / 100))`,
            [orderId, change.proposed_garment_type_id, change.proposed_name, change.proposed_unit, change.proposed_rate_paise, storedQuantity, change.proposed_rate_paise, change.proposed_total_paise, change.proposed_total_paise]
          )
        } else if (change.is_weight_adjustment) {
          await client.query(
            `UPDATE order_lines
             SET confirmed_quantity = 1, total_paise = $1, total = ($2::numeric / 100),
                 garment_type_id = $3, name = $4, unit = $5, rate_paise = $6
             WHERE id = $7`,
            [change.proposed_total_paise, change.proposed_total_paise, change.proposed_garment_type_id, change.proposed_name, change.proposed_unit, change.proposed_rate_paise, change.order_line_id]
          )
        } else {
          await client.query(
            `UPDATE order_lines
             SET confirmed_quantity = $1, quantity = $1, total_paise = $2, total = ($3::numeric / 100),
                 garment_type_id = $4, name = $5, unit = $6, rate_paise = $7
             WHERE id = $8`,
            [change.proposed_quantity, change.proposed_total_paise, change.proposed_total_paise, change.proposed_garment_type_id, change.proposed_name, change.proposed_unit, change.proposed_rate_paise, change.order_line_id]
          )
        }
      }

      const feeBreakdown = typeof order.fee_breakdown === 'string'
        ? JSON.parse(order.fee_breakdown)
        : (order.fee_breakdown || {})
      const newFeeBreakdown = {
        ...feeBreakdown,
        subtotal_paise: reconciliation.proposed_subtotal_paise,
        original_subtotal_paise: reconciliation.previous_subtotal_paise,
      }

      // processing_stage must move to 'Washing' here, not stay at the
      // 'Received' value set when the order first arrived at the vendor —
      // vendor-orders.service.js's updateProcessingStage treats
      // status=PROCESSING + processing_stage='Received' as an invalid
      // combination (its own WASHING/DRYING/IRONING/PACKED sub-sequence
      // expects a real stage name once status is PROCESSING), which broke
      // "Mark Packed & Ready" with "Cannot go from RECEIVED to PACKED".
      // Accepting the reconciliation is exactly the moment washing begins.
      await client.query(
        `UPDATE orders
         SET status = $1, processing_stage = 'Washing',
             estimated_amount_paise = $2, payable_amount_paise = $3,
             subtotal = ($4::numeric / 100), total_amount = ($5::numeric / 100),
             fee_breakdown = $6, updated_at = NOW()
         WHERE id = $7`,
        [
          ORDER_STATUSES.PROCESSING, reconciliation.proposed_subtotal_paise, reconciliation.proposed_payable_amount_paise,
          reconciliation.proposed_subtotal_paise, reconciliation.proposed_payable_amount_paise,
          JSON.stringify(newFeeBreakdown), orderId,
        ]
      )

      await client.query(
        `UPDATE order_reconciliations
         SET status = 'ACCEPTED', customer_decision_at = NOW(), customer_decision_by = $1, updated_at = NOW()
         WHERE id = $2`,
        [userId, reconciliation.id]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: ORDER_STATUSES.PROCESSING,
        actorId: userId,
        actorRole: 'CUSTOMER',
        note: 'Customer accepted the vendor\'s recalculated total',
      })

      await client.query('COMMIT')

      // (Laundry notification: sent by the lifecycle engine from the status change.)

      return { orderId, status: ORDER_STATUSES.PROCESSING }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Customer rejects the vendor's proposed recalculation. Does NOT touch
   * order_lines/orders totals — they stay at whatever the rider already
   * applied. Resolution from here is a manual support phone call, not
   * another automated flow, so the response carries the support number
   * directly.
   */
  async rejectReconciliation(userId, orderId, reason) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const orderRes = await client.query(
        `SELECT id, status, user_id FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [orderId, userId]
      )
      const order = orderRes.rows[0]
      if (!order) throw { statusCode: 404, message: 'Order not found', code: 'ORDER_NOT_FOUND' }

      const reconRes = await client.query(
        `SELECT * FROM order_reconciliations WHERE order_id = $1 AND status = 'PENDING_CUSTOMER' FOR UPDATE`,
        [orderId]
      )
      const reconciliation = reconRes.rows[0]
      if (!reconciliation) throw { statusCode: 404, message: 'No reconciliation awaiting your approval', code: 'RECONCILIATION_NOT_FOUND' }

      const transition = validateTransition(order.status, ORDER_STATUSES.RECONCILIATION_DISPUTED, 'CUSTOMER')
      if (!transition.valid) throw { statusCode: 400, message: transition.message, code: 'INVALID_TRANSITION' }

      await client.query(
        `UPDATE order_reconciliations
         SET status = 'REJECTED', reason = COALESCE($1, reason), customer_decision_at = NOW(), customer_decision_by = $2, updated_at = NOW()
         WHERE id = $3`,
        [reason || null, userId, reconciliation.id]
      )

      await client.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
        [ORDER_STATUSES.RECONCILIATION_DISPUTED, orderId]
      )

      await recordOrderEvent(client, {
        orderId,
        oldStatus: order.status,
        newStatus: ORDER_STATUSES.RECONCILIATION_DISPUTED,
        actorId: userId,
        actorRole: 'CUSTOMER',
        note: reason ? `Customer rejected the recalculated total: ${reason}` : 'Customer rejected the recalculated total',
      })

      await client.query('COMMIT')

      // (Laundry notification: sent by the lifecycle engine from the status change.)

      const supportRes = await query(`SELECT value FROM app_settings WHERE key = 'support_phone'`)
      const supportPhone = supportRes.rows[0]?.value ?? null

      return { orderId, status: ORDER_STATUSES.RECONCILIATION_DISPUTED, support_phone: supportPhone }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
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
   * PDF invoice for one of the customer's orders.
   *
   * Kept for older clients that call GET /orders/:id/invoice — it now serves
   * the same backend-issued, numbered invoice as the /invoices API (the old
   * version rendered a throw-away PDF from raw order fields, read camelCase
   * rows with snake_case keys, and so denied every request).
   */
  async getInvoice(userId, orderId) {
    try {
      const file = await new InvoicesService().getPdfForCustomer(userId, orderId)
      return { success: true, buffer: file.buffer, fileName: file.fileName }
    } catch (err) {
      if (err instanceof InvoiceError) {
        return { success: false, statusCode: err.statusCode, message: err.message }
      }
      throw err
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

  /**
   * Attaches photo evidence and any vendor-reported line-item problems
   * (damaged item, item not applicable to this service, etc. — see
   * reconciliation-problem-types module) to a reconciliation row for
   * customer/vendor display. Rider-stage reconciliations never have
   * problems attached (only the vendor's reconcile flow proposes them),
   * so the query just comes back empty for those — no branching needed.
   */
  async _attachReconciliationPhotos(row) {
    if (!row) return null
    const [photosRes, problemsRes] = await Promise.all([
      query(
        `SELECT photo_url FROM order_pickup_photos WHERE order_reconciliation_id = $1 ORDER BY created_at ASC`,
        [row.id]
      ),
      query(
        `SELECT p.id, p.order_line_id, p.new_line_index, p.problem_type_id, p.custom_message, p.photo_urls, p.created_at,
                pt.label AS problem_type_label
         FROM order_reconciliation_problems p
         LEFT JOIN reconciliation_problem_types pt ON pt.id = p.problem_type_id
         WHERE p.order_reconciliation_id = $1
         ORDER BY p.created_at ASC`,
        [row.id]
      ),
    ])
    return {
      ...row,
      photos: photosRes.rows.map((r) => r.photo_url),
      problems: problemsRes.rows.map((p) => ({
        id: p.id,
        orderLineId: p.order_line_id,
        newLineIndex: p.new_line_index,
        problemTypeId: p.problem_type_id,
        problemTypeLabel: p.problem_type_label,
        customMessage: p.custom_message,
        photoUrls: p.photo_urls,
        createdAt: p.created_at,
      })),
    }
  }

  async _enrichCustomerOrder(order) {
    const [statusHistory, riderLocation, paidRes, riderReconRes, vendorReconRes, liveItems, paymentsRes] = await Promise.all([
      this.repo.getStatusHistory(order.id),
      order.riderId && this.fastify?.getRiderLocation
        ? this.fastify.getRiderLocation(order.riderId).catch(() => null)
        : Promise.resolve(null),
      query(`SELECT COALESCE(SUM(amount), 0) AS amount_paid FROM payments WHERE order_id = $1 AND status = 'PAID'`, [order.id]),
      // Rider's immediate-apply weigh-in — informational, no accept/reject.
      query(`SELECT * FROM order_reconciliations WHERE order_id = $1 AND stage = 'RIDER_PICKUP' ORDER BY created_at DESC LIMIT 1`, [order.id]),
      // Vendor's authoritative recalculation — the one the customer may need to act on.
      query(`SELECT * FROM order_reconciliations WHERE order_id = $1 AND stage = 'VENDOR_RECEIPT' ORDER BY created_at DESC LIMIT 1`, [order.id]),
      // order.items (JSONB) is a snapshot frozen at checkout — it never
      // reflects a rider/vendor correction or reclassification. order_lines
      // is the live source of truth, so it replaces the snapshot here
      // whenever it has rows (older orders predating order_lines fall back
      // to the snapshot).
      this.repo.getOrderItems(order.id),
      // Full payment history (ADVANCE + BALANCE, and any failed/pending
      // attempts), oldest first — orders.payment_method alone only ever
      // encodes the checkout-time COD-vs-online choice, never which method
      // actually settled each leg (the advance and balance can genuinely
      // differ, e.g. advance via Razorpay, balance via the LNDRY wallet).
      query(
        `SELECT id, purpose, method, status, amount, created_at FROM payments WHERE order_id = $1 ORDER BY created_at ASC`,
        [order.id]
      ),
    ])

    const [riderReevaluation, vendorReevaluation] = await Promise.all([
      this._attachReconciliationPhotos(riderReconRes.rows[0] || null),
      this._attachReconciliationPhotos(vendorReconRes.rows[0] || null),
    ])

    // `order` here is already camelCased by orders.repository.js's _format()
    // (fee_breakdown -> feeBreakdown) — reading the snake_case key always
    // resolved to {}, silently falling back to the hardcoded 2900/500
    // defaults below instead of this order's real delivery/platform fee.
    const feeBreakdown = typeof order.feeBreakdown === 'string'
      ? JSON.parse(order.feeBreakdown)
      : (order.feeBreakdown || {})

    const orderWithLiveItems = liveItems.length > 0 ? { ...order, items: liveItems } : order
    const [enriched] = await this._attachItemThumbnails([orderWithLiveItems])

    // Root-caused: amountPaidPaise was always computed correctly here, but
    // orderResponseSchema didn't declare it, so fast-json-stringify silently
    // stripped it from every response before the app ever saw it (fixed in
    // orders.schema.js). A genuinely-zero amount is a normal state (advance
    // not yet paid), not a bug, so no diagnostic logging is needed here.
    const amountPaidPaise = Math.round(Number(paidRes.rows[0]?.amount_paid || 0) * 100)

    // Customer-facing shape only — deliberately excludes Razorpay's
    // internal order/payment/signature IDs, which this screen never needs.
    const payments = paymentsRes.rows.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      method: row.method || null,
      status: row.status,
      amountPaise: Math.round(Number(row.amount) * 100),
      createdAt: row.created_at,
    }))

    return {
      ...enriched,
      timeline: this._buildCustomerTimeline(order, statusHistory || []),
      tracking: this._buildTrackingData(order, riderLocation),
      amountPaidPaise,
      deliveryFeePaise: feeBreakdown.delivery_fee_paise ?? 2900,
      platformFeePaise: feeBreakdown.platform_fee_paise ?? 500,
      payments,
      riderReevaluation,
      vendorReevaluation,
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
    const expressFee = Number(feeBreakdown.express_fee_paise || 0)
    const discount = Number(feeBreakdown.discount_paise || 0)
    const totalPayable = Number(feeBreakdown.total_payable_paise || 0)
    const expected = subtotal + deliveryFee + platformFee + tax + expressFee - discount

    if (expected !== totalPayable) {
      throw {
        statusCode: 500,
        message: 'Checkout pricing breakdown is internally inconsistent',
        code: 'PRICING_BREAKDOWN_MISMATCH'
      }
    }
  }

  async _buildDraftFeeBreakdown({ quote, vendor, distanceKm, couponDiscount = 0, isExpressPickup = false }) {
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
    const expressFeePaise = isExpressPickup ? Number(config.express_pickup_fee_paise || 0) : 0
    const totalPayablePaise =
      subtotalPaise + deliveryFeePaise + platformFeePaise + taxPaise + expressFeePaise - discountPaise

    const feeBreakdown = {
      subtotal_paise: subtotalPaise,
      delivery_fee_paise: deliveryFeePaise,
      platform_fee_paise: platformFeePaise,
      tax_paise: taxPaise,
      express_fee_paise: expressFeePaise,
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
      express_fee_paise: Number(parsed.express_fee_paise || 0),
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
    const isExpressPickup = !!(body.isExpressPickup || body.is_express_pickup)

    if (!isExpressPickup && !slotId) {
      return { success: false, message: 'slot_id is required unless this is an express pickup', code: 'SLOT_REQUIRED' }
    }

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
      `SELECT id, is_active, status, lat, lng, approved_service_radius_km, vendor_approved, account_enabled, marketplace_published, express_pickup_available
       FROM vendors
       WHERE id = $1 AND deleted_at IS NULL`,
      [quote.vendor_id]
    )
    const vendor = vendorRes.rows[0]
    if (!vendor || !vendor.is_active || vendor.status !== 'APPROVED' || !vendor.vendor_approved || !vendor.account_enabled || !vendor.marketplace_published) {
      return { success: false, message: 'Vendor is not available for service', code: 'VENDOR_UNAVAILABLE' }
    }
    if (isExpressPickup && !vendor.express_pickup_available) {
      return { success: false, message: 'Express pickup is not available for this vendor', code: 'EXPRESS_PICKUP_UNAVAILABLE' }
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

    // 4. Verify slot hold ownership (must match the user and the quote).
    // Express pickup bypasses the vendor_slots capacity system entirely —
    // a rider is dispatched within the hour regardless of scheduled slots —
    // so there's no hold to verify; booking_date is simply today.
    let bookingDate
    if (isExpressPickup) {
      bookingDate = new Date().toISOString().slice(0, 10)
    } else {
      const holdRes = await query(
        `SELECT booking_date FROM slot_holds
         WHERE customer_id = $1 AND slot_id = $2 AND vendor_id = $3 AND quote_id = $4 AND expires_at > NOW()
         LIMIT 1`,
        [userId, slotId, quote.vendor_id, quoteId]
      )
      if (holdRes.rows.length === 0) {
        return { success: false, message: 'No active slot hold found. Please hold a pickup slot before checkout.', code: 'NO_SLOT_HOLD' }
      }
      bookingDate = holdRes.rows[0].booking_date
    }

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

    // 4c. First-time offer — auto-applies for eligible first-time customers,
    // no code needed (adapted from bakaloo-backend's orders.service.js).
    // Discount-type rewards (FLAT_DISCOUNT/PERCENTAGE_DISCOUNT) yield to an
    // already-applied coupon — they'd otherwise stack two separate
    // order-level discounts through different mechanisms. COUPON_UNLOCK
    // doesn't touch the discount line at all, so it always applies when
    // eligible; its effect (adding the customer to the unlocked coupon's
    // individual-target list) only actually happens once the order is
    // confirmed — see placeOrderFromDraft below — so an abandoned draft
    // never grants it.
    let firstTimeOffer = null
    let firstTimeReward = null
    const subtotalRupeesForOffer = this._paiseToRupees(quote.estimate_paise)
    const resolvedOffer = await this.firstTimeOffersService.resolveForCheckout(userId, subtotalRupeesForOffer)
    let extraDiscount = 0
    if (resolvedOffer?.autoApply) {
      if (resolvedOffer.rewardType === 'FREE_DELIVERY') {
        // Needs the actual delivery fee, which only the fee engine knows —
        // compute a first-pass breakdown with just the coupon discount to
        // learn it, then fold the delivery fee in as an extra discount below.
        const preBreakdown = await this._buildDraftFeeBreakdown({
          quote, vendor, distanceKm: distance, couponDiscount: appliedCouponDiscount,
        })
        const reward = this.firstTimeOffersService.computeReward(
          resolvedOffer, subtotalRupeesForOffer, this._paiseToRupees(preBreakdown.delivery_fee_paise)
        )
        firstTimeOffer = resolvedOffer
        firstTimeReward = reward
        extraDiscount = reward.deliveryFeeAmount || 0
      } else {
        const reward = this.firstTimeOffersService.computeReward(resolvedOffer, subtotalRupeesForOffer)
        if (reward.discount && appliedCouponCode) {
          // Discount slot already taken by a coupon — skip the stack.
        } else {
          firstTimeOffer = resolvedOffer
          firstTimeReward = reward
          extraDiscount = reward.discount || 0
        }
      }
    }

    // 4d. Cart milestone — the highest order-value tier this user is
    // eligible for and has already reached with this order (applies to
    // every order, not just a customer's first, unlike the first-time
    // offer above). `stackableWithCoupon` is a hard admin toggle: false
    // means the milestone is skipped outright whenever a coupon code was
    // applied to this order. When it does apply, a FLAT_DISCOUNT reward
    // still yields to a discount already occupying the bill's single
    // discount slot (coupon or first-time-offer FLAT/PERCENTAGE_DISCOUNT —
    // not FREE_DELIVERY, which doesn't touch that slot). COUPON_UNLOCK
    // never contends for the slot; its effect is deferred to
    // placeOrderFromDraft's post-commit step, same as the first-time-offer
    // COUPON_UNLOCK handling above, so an abandoned draft never grants it.
    let cartMilestone = null
    let cartMilestoneReward = null
    const resolvedMilestone = await this.cartMilestonesService.resolveForCheckout(userId, subtotalRupeesForOffer)
    if (resolvedMilestone && !(appliedCouponCode && !resolvedMilestone.stackableWithCoupon)) {
      const reward = this.cartMilestonesService.computeReward(resolvedMilestone, subtotalRupeesForOffer)
      if (reward.discount && (appliedCouponCode || firstTimeReward?.discount)) {
        // Discount slot already taken by a coupon or first-time offer.
      } else {
        cartMilestone = resolvedMilestone
        cartMilestoneReward = reward
        extraDiscount += reward.discount || 0
      }
    }

    // 4e. Referral reward credit (Refer & Earn, Phase 3) — a free express
    // or standard delivery earned via referral, redeemed automatically
    // like the rewards above (no code needed). Always stacks — never
    // yields to a coupon/first-time-offer/cart-milestone discount — same
    // precedent First-Time-Offer's FREE_DELIVERY already set: "free
    // delivery" and "money off" are different benefits, not competitors
    // for the same discount slot. Only consumed if it actually reduces
    // what's owed (checked below via the real computed fee, not just
    // "is express pickup"), so an earned credit is never silently wasted
    // on an order that would've been free/inapplicable anyway — e.g. a
    // FREE_STANDARD_DELIVERY credit does nothing on an order already above
    // fee_settings.free_delivery_above. Snapshot the reservation (not yet
    // consumed — see placeOrderFromDraft below) rather than decrementing
    // now, so an abandoned draft never spends a credit for nothing.
    let referralCredit = null
    const referralCreditType = isExpressPickup ? 'FREE_EXPRESS_DELIVERY' : 'FREE_STANDARD_DELIVERY'
    const availableReferralCredit = await this.referralsRepo.getCredit(userId, referralCreditType)
    if (availableReferralCredit > 0) {
      const preReferralBreakdown = await this._buildDraftFeeBreakdown({
        quote, vendor, distanceKm: distance,
        couponDiscount: appliedCouponDiscount + extraDiscount,
        isExpressPickup,
      })
      const feeToWaivePaise = isExpressPickup
        ? preReferralBreakdown.express_fee_paise
        : preReferralBreakdown.delivery_fee_paise
      if (feeToWaivePaise > 0) {
        referralCredit = { creditType: referralCreditType }
        extraDiscount += this._paiseToRupees(feeToWaivePaise)
      }
    }

    // 5. Canonical backend pricing. Quote owns item pricing; TotalsEngine owns
    // fees/taxes/discount math so draft and final order use the same snapshot.
    const feeBreakdown = await this._buildDraftFeeBreakdown({
      quote,
      vendor,
      distanceKm: distance,
      couponDiscount: appliedCouponDiscount + extraDiscount,
      isExpressPickup,
    })
    const payableAmount = feeBreakdown.total_payable_paise

    const snapshot = {
      quote,
      address,
      slot_id: isExpressPickup ? null : slotId,
      booking_date: bookingDate,
      is_express_pickup: isExpressPickup,
      fee_breakdown: feeBreakdown,
      first_time_offer: firstTimeOffer
        ? { id: firstTimeOffer.id, name: firstTimeOffer.name, rewardType: firstTimeOffer.rewardType, unlockCouponId: firstTimeReward?.unlockCouponId ?? null }
        : null,
      cart_milestone: cartMilestone
        ? { id: cartMilestone.id, name: cartMilestone.name, rewardType: cartMilestone.rewardType, unlockCouponId: cartMilestoneReward?.unlockCouponId ?? null }
        : null,
      referral_credit: referralCredit,
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
        isExpressPickup ? null : slotId,
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

      // 2. Lock payment FOR UPDATE — every order, COD or ONLINE, now requires
      // a PAID advance before it can be created. COD only ever meant "pay
      // the *balance* on delivery"; there's no one physically present at
      // checkout time to hand cash to, so the advance is unconditional.
      const paymentRes = await client.query('SELECT * FROM payments WHERE order_draft_id = $1 AND status = \'PAID\' FOR UPDATE', [orderDraftId])
      const payment = paymentRes.rows[0]
      if (!payment) {
        throw { statusCode: 400, message: 'Advance payment not verified. Please complete payment first.', code: 'PAYMENT_PENDING' }
      }

      const snapshot = typeof draft.snapshot === 'string' ? JSON.parse(draft.snapshot) : draft.snapshot
      const quoteId = snapshot.quote?.quote_id || snapshot.quote?.id

      // 3-5. Slot hold lock + vendor slot capacity lock/enforcement — skipped
      // entirely for express pickup, which bypasses the vendor_slots capacity
      // system by design (see prepareOrder above): there's no hold and no
      // slot row to lock against.
      const isExpressPickup = !!snapshot.is_express_pickup
      let hold = null
      if (!isExpressPickup) {
        // 3. Lock slot hold FOR UPDATE
        const holdRes = await client.query(
          'SELECT * FROM slot_holds WHERE customer_id = $1 AND slot_id = $2 AND vendor_id = $3 AND quote_id = $4 AND status = \'ACTIVE\' AND expires_at > NOW() FOR UPDATE',
          [userId, draft.slot_id, draft.vendor_id, quoteId]
        )
        hold = holdRes.rows[0]
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
           fee_breakdown, coupon_code, is_express_pickup
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
          'ADVANCE_PAID',
          JSON.stringify(snapshot.address),
          isExpressPickup ? null : draft.slot_id,
          snapshot.booking_date,
          feeBreakdown.subtotal_paise,
          feeBreakdown.total_payable_paise,
          JSON.stringify(feeBreakdown),
          appliedCouponCode,
          isExpressPickup
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

      // 10. Link the advance payment (COD and ONLINE both have one now — only
      // the balance leg differs between them) and consume the slot hold
      if (payment) {
        await client.query('UPDATE payments SET order_id = $1 WHERE id = $2', [order.id, payment.id])
      }
      if (hold) {
        await client.query('UPDATE slot_holds SET status = \'CONSUMED\' WHERE id = $1', [hold.id])
      }

      await client.query('COMMIT')

      if (appliedCouponCode) {
        try {
          await this.couponsService.recordUsage(appliedCouponCode, userId, order.id)
        } catch (err) {
          logger.warn({ err: err.message, orderId: order.id }, 'Coupon usage recording failed')
        }
      }

      // First-time-offer COUPON_UNLOCK reward — only takes effect now that
      // the order is actually confirmed, not at draft-prepare time, so an
      // abandoned draft never grants it (see prepareOrder above).
      const unlockCouponId = snapshot.first_time_offer?.unlockCouponId
      if (unlockCouponId) {
        try {
          await this.couponsRepo.addTargetUser(unlockCouponId, userId)
        } catch (err) {
          logger.warn({ err: err.message, orderId: order.id }, 'First-time-offer coupon unlock failed')
        }
      }

      // Cart milestone follow-through — same deferred-until-confirmed
      // pattern as the first-time-offer block above, plus a usage record
      // (a milestone can be earned repeatedly, unlike a first-time offer).
      if (snapshot.cart_milestone) {
        try {
          const milestoneUnlockCouponId = snapshot.cart_milestone.unlockCouponId
          if (milestoneUnlockCouponId) {
            await this.couponsRepo.addTargetUser(milestoneUnlockCouponId, userId)
          }
          await this.cartMilestonesService.recordUsage(snapshot.cart_milestone.id, userId, order.id)
        } catch (err) {
          logger.warn({ err: err.message, orderId: order.id }, 'Cart milestone follow-through failed')
        }
      }

      // Referral reward credit follow-through — the reservation made in
      // prepareOrder (see snapshot.referral_credit) is only actually spent
      // now that the order is real, mirroring the coupon-usage/milestone
      // pattern above; an abandoned draft never consumes it.
      if (snapshot.referral_credit) {
        try {
          await this.referralsRepo.consumeCredit(userId, snapshot.referral_credit.creditType)
        } catch (err) {
          logger.warn({ err: err.message, orderId: order.id }, 'Referral credit consumption failed')
        }
      }

      // Referral completion — if this buyer was referred and this is their
      // genuine first order (never true for the draft's own just-inserted
      // row alone; isFirstOrder explicitly excludes it), grant whichever
      // side(s) of the referral are ON_FIRST_ORDER_COMPLETE-triggered and
      // still pending. Same deferred-until-confirmed reasoning as the two
      // blocks above — an abandoned draft never grants anything.
      try {
        await this.referralsService.completeReferralForOrder(userId, order.id)
      } catch (err) {
        logger.warn({ err: err.message, orderId: order.id }, 'Referral completion failed')
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
        // The response schema only declares camelCase fields, so the raw DB
        // row's `order_number` was being stripped — the app then showed the
        // last 8 chars of the UUID instead of the real order number.
        order: { ...order, orderNumber: order.order_number },
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
