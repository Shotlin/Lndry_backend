import { CartRepository } from './cart.repository.js'
import { CartService } from './cart.service.js'
import { FeeSettingsService } from '../../src/modules/fee-settings/fee-settings.service.js'
import { TotalsEngine } from './totals-engine.service.js'
import { haversineKm } from '../../src/utils/distance.js'
import { query } from '../../src/config/database.js'
import { logger } from '../../src/config/logger.js'

/**
 * Bill summary service — computes the complete cart bill breakdown for
 * GET /api/v1/cart/summary.
 *
 * Source of truth: the canonical {@link TotalsEngine} + the `fee_settings`
 * config. Delivery fee is dynamic (distance-based) and computed per shop so
 * the summary agrees with what order creation actually charges (orders split
 * per shop). Distance is the haversine between the customer's selected/default
 * delivery address and each shop.
 *
 * Backward compatibility: the response keeps the original keys
 * (itemTotal, deliveryFee{amount,isFree,freeIn}, handlingFee, lateNightFee,
 * toPay, savings, deliveryEstimate, couponDiscount, tipAmount, itemCount) so
 * the current Flutter build keeps working, AND adds the new canonical fields
 * (totals, fees[], distance, freeDelivery, platformFee, smallCartFee, …) for
 * the redesigned bill UI.
 */
export class BillSummaryService {
  constructor({
    cartService = null,
    cartRepository = null,
    feeSettingsService = null,
    totalsEngine = null,
  } = {}) {
    this.cartRepository = cartRepository ?? new CartRepository()
    this.cartService = cartService ?? new CartService(this.cartRepository)
    this.feeSettingsService = feeSettingsService ?? new FeeSettingsService()
    this.totalsEngine =
      totalsEngine ?? new TotalsEngine({ feeSettingsService: this.feeSettingsService })
  }

  /**
   * Compute the bill summary for a user's cart.
   * @param {string} userId
   * @param {string|null} [addressId] - optional selected address; defaults to the user's default address
   */
  async getBillSummary(userId, addressId = null) {
    const cart = await this.cartService.getCart(userId)
    if (!cart.items || cart.items.length === 0) {
      return this._emptyBill()
    }

    const itemTotalDiscounted = this._round(cart.subtotal)
    const itemTotalOriginal = this._round(cart.totalMrp || cart.subtotal)
    const mrpDiscount = this._round(Math.max(0, itemTotalOriginal - itemTotalDiscounted))
    const tipAmount = this._toNumber(cart.tipAmount)

    // Resolve delivery coordinates + per-shop distances.
    const address = await this._resolveAddress(userId, addressId)
    const shopGroups = cart.shopGroups || []
    const shopIds = shopGroups.map((g) => g.shopId)
    const shopMeta = await this._getShopMeta(shopIds)

    // Compute a per-shop breakdown via the engine and aggregate. Delivery and
    // each fee are charged per shop (matching order splitting); the aggregate
    // is what the customer pays in total.
    const { config } = await this.feeSettingsService.resolveForShop(
      shopGroups.length === 1 ? shopGroups[0].shopId : null
    )

    let deliveryFee = 0
    let deliveryFeeOriginal = 0
    let handlingFee = 0
    let platformFee = 0
    let smallCartFee = 0
    let surgeFee = 0
    let packagingFee = 0
    let anyDeliveryWaived = false
    let primaryDistanceKm = null
    let primaryStoreName = null
    let amountToUnlock = 0

    for (const group of shopGroups) {
      const meta = shopMeta.get(group.shopId) || {}
      const distanceKm =
        address && Number.isFinite(meta.lat) && Number.isFinite(meta.lng)
          ? haversineKm(address.lat, address.lng, meta.lat, meta.lng)
          : null

      const shopConfigResolved = await this.feeSettingsService.resolveForShop(group.shopId)
      const breakdown = this.totalsEngine.computeBreakdown({
        config: shopConfigResolved.config,
        itemsSubtotal: group.subtotal,
        distanceKm,
        storeName: meta.name || group.shopName || null,
      })

      deliveryFee = this._round(deliveryFee + breakdown.deliveryFee)
      deliveryFeeOriginal = this._round(deliveryFeeOriginal + breakdown.deliveryFeeOriginal)
      handlingFee = this._round(handlingFee + breakdown.handlingFee)
      platformFee = this._round(platformFee + breakdown.platformFee)
      smallCartFee = this._round(smallCartFee + breakdown.smallCartFee)
      surgeFee = this._round(surgeFee + breakdown.surgeFee)
      packagingFee = this._round(packagingFee + breakdown.packagingFee)
      if (breakdown.deliveryFeeWaived) anyDeliveryWaived = true
      amountToUnlock = this._round(amountToUnlock + breakdown.freeDelivery.amountToUnlock)

      // Use the primary (first / single) shop for the headline distance label.
      if (primaryDistanceKm === null && breakdown.distance.known) {
        primaryDistanceKm = breakdown.distance.km
        primaryStoreName = meta.name || group.shopName || null
      }
    }

    // Build a single aggregate breakdown for the canonical response.
    const aggregate = this.totalsEngine.computeBreakdown({
      config,
      itemsSubtotal: itemTotalDiscounted,
      itemDiscount: mrpDiscount,
      distanceKm: primaryDistanceKm,
      tipAmount,
      storeName: primaryStoreName,
    })

    // Override the aggregate's per-fee numbers with the summed per-shop values
    // so multi-shop carts reflect the real charge.
    aggregate.deliveryFee = deliveryFee
    aggregate.deliveryFeeOriginal = deliveryFeeOriginal
    aggregate.deliveryFeeWaived = anyDeliveryWaived && deliveryFee === 0
    aggregate.handlingFee = handlingFee
    aggregate.platformFee = platformFee
    aggregate.smallCartFee = smallCartFee
    aggregate.surgeFee = surgeFee
    aggregate.packagingFee = packagingFee
    aggregate.freeDelivery.amountToUnlock = aggregate.deliveryFeeWaived ? 0 : amountToUnlock
    aggregate.freeDelivery.unlocked = aggregate.deliveryFeeWaived

    const feesTotal = this._round(
      deliveryFee + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee
    )
    const toPayFinal = this._round(itemTotalDiscounted + feesTotal + tipAmount)
    const toPayOriginal = this._round(
      itemTotalOriginal + deliveryFeeOriginal + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + tipAmount
    )
    aggregate.totalPayable = toPayFinal
    aggregate.itemsSubtotal = itemTotalDiscounted
    aggregate.itemDiscount = mrpDiscount

    // Rebuild the canonical fees[] array from aggregated values.
    aggregate.fees = this._buildFeesArray({
      config,
      deliveryFee,
      deliveryFeeOriginal,
      deliveryWaived: aggregate.deliveryFeeWaived,
      handlingFee,
      platformFee,
      smallCartFee,
      surgeFee,
      packagingFee,
      distanceKm: primaryDistanceKm,
      storeName: primaryStoreName,
      amountToUnlock,
    })

    const deliveryEstimateMinutes = this._toNumber(config.delivery_eta_minutes) || 30
    const freeThreshold = aggregate.freeDelivery.threshold

    // ── Legacy-compatible shape + new canonical fields ──────────
    return {
      // legacy keys (current Flutter)
      itemTotal: {
        original: itemTotalOriginal,
        discounted: itemTotalDiscounted,
      },
      deliveryFee: {
        amount: deliveryFee,
        isFree: aggregate.deliveryFeeWaived,
        freeIn: aggregate.deliveryFeeWaived ? 0 : amountToUnlock,
        originalAmount: deliveryFeeOriginal,
        waiverReason: aggregate.deliveryFeeWaiverReason,
      },
      handlingFee: {
        amount: handlingFee,
        isFree: handlingFee <= 0,
        savedAmount: 0,
      },
      lateNightFee: {
        amount: 0,
        isFree: true,
        savedAmount: 0,
        isLateNight: false,
      },
      couponDiscount: 0, // applied by coupon system at checkout
      tipAmount,
      toPay: {
        original: toPayOriginal,
        final: toPayFinal,
      },
      savings: {
        total: aggregate.totalSavings,
        breakdown: mrpDiscount > 0
          ? [{ type: 'mrp_discount', label: 'Discount on MRP', amount: mrpDiscount }]
          : [],
      },
      deliveryEstimate: {
        minutes: deliveryEstimateMinutes,
        label: `Delivering in ${deliveryEstimateMinutes} mins`,
      },
      itemCount: cart.count,

      // new canonical fields (redesigned bill UI)
      totals: aggregate,
      fees: aggregate.fees,
      distance: aggregate.distance,
      freeDelivery: {
        enabled: aggregate.freeDelivery.enabled,
        threshold: freeThreshold,
        unlocked: aggregate.deliveryFeeWaived,
        amountToUnlock: aggregate.deliveryFeeWaived ? 0 : amountToUnlock,
      },
      platformFee: { amount: platformFee, isFree: platformFee <= 0 },
      smallCartFee: { amount: smallCartFee, isFree: smallCartFee <= 0 },
      totalPayable: toPayFinal,
    }
  }

  /** Build the canonical fees[] array from aggregated fee values. */
  _buildFeesArray({
    config,
    deliveryFee,
    deliveryFeeOriginal,
    deliveryWaived,
    handlingFee,
    platformFee,
    smallCartFee,
    surgeFee,
    packagingFee,
    distanceKm,
    storeName,
    amountToUnlock,
  }) {
    const fees = []
    if (config.delivery_fee_enabled) {
      const desc = deliveryWaived
        ? 'Free delivery unlocked'
        : distanceKm !== null && distanceKm !== undefined
          ? `Calculated for ${Number(distanceKm).toFixed(1)} km${storeName ? ` from ${storeName}` : ''}`
          : 'Standard delivery charge'
      fees.push({
        code: 'DELIVERY_FEE',
        label: config.delivery_fee_label || 'Delivery fee',
        amount: deliveryFee,
        originalAmount: deliveryFeeOriginal,
        waived: deliveryWaived,
        description: desc,
        metadata: { distanceKm: distanceKm ?? null, storeName: storeName || null },
      })
    }
    if (handlingFee > 0) {
      fees.push({
        code: 'HANDLING_FEE',
        label: config.handling_fee_label || 'Handling fee',
        amount: handlingFee,
        originalAmount: handlingFee,
        waived: false,
        description: config.handling_fee_description || 'Covers packing and order handling.',
        metadata: {},
      })
    }
    if (platformFee > 0) {
      fees.push({
        code: 'PLATFORM_FEE',
        label: config.platform_fee_label || 'Platform fee',
        amount: platformFee,
        originalAmount: platformFee,
        waived: false,
        description: config.platform_fee_description || 'Supports platform operations and support.',
        metadata: {},
      })
    }
    if (smallCartFee > 0) {
      fees.push({
        code: 'SMALL_CART_FEE',
        label: config.small_cart_fee_label || 'Small cart fee',
        amount: smallCartFee,
        originalAmount: smallCartFee,
        waived: false,
        description: config.small_cart_fee_description || 'Applied to small orders.',
        metadata: {},
      })
    }
    if (surgeFee > 0) {
      fees.push({
        code: 'SURGE_FEE',
        label: config.surge_fee_label || 'Surge fee',
        amount: surgeFee,
        originalAmount: surgeFee,
        waived: false,
        description: config.surge_fee_description || 'Temporary surcharge during high demand.',
        metadata: {},
      })
    }
    if (packagingFee > 0) {
      fees.push({
        code: 'PACKAGING_FEE',
        label: config.packaging_fee_label || 'Packaging fee',
        amount: packagingFee,
        originalAmount: packagingFee,
        waived: false,
        description: config.packaging_fee_description || 'Covers packaging materials.',
        metadata: {},
      })
    }
    return fees
  }

  /** Resolve the delivery address (selected or default) with coordinates. */
  async _resolveAddress(userId, addressId) {
    try {
      if (addressId) {
        const { rows } = await query(
          `SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2 LIMIT 1`,
          [addressId, userId]
        )
        if (rows[0] && rows[0].lat != null && rows[0].lng != null) {
          return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
        }
      }
      const { rows } = await query(
        `SELECT lat, lng FROM addresses
          WHERE user_id = $1 AND lat IS NOT NULL AND lng IS NOT NULL
          ORDER BY is_default DESC, created_at DESC
          LIMIT 1`,
        [userId]
      )
      if (rows[0]) return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
    } catch (err) {
      logger.warn({ userId, err: err.message, action: 'bill_summary_address' }, 'Address resolve failed')
    }
    return null
  }

  /** Fetch lat/lng/name for a set of vendors. */
  async _getShopMeta(shopIds) {
    const map = new Map()
    if (!shopIds || shopIds.length === 0) return map
    try {
      const { rows } = await query(
        `SELECT id, name, lat, lng FROM vendors WHERE id = ANY($1)`,
        [shopIds]
      )
      for (const r of rows) {
        map.set(r.id, {
          name: r.name,
          lat: r.lat != null ? Number(r.lat) : NaN,
          lng: r.lng != null ? Number(r.lng) : NaN,
        })
      }
    } catch (err) {
      logger.warn({ err: err.message, action: 'bill_summary_shop_meta' }, 'Shop meta fetch failed')
    }
    return map
  }

  _emptyBill() {
    return {
      itemTotal: { original: 0, discounted: 0 },
      deliveryFee: { amount: 0, isFree: false, freeIn: 0, originalAmount: 0, waiverReason: null },
      handlingFee: { amount: 0, isFree: true, savedAmount: 0 },
      lateNightFee: { amount: 0, isFree: true, savedAmount: 0, isLateNight: false },
      couponDiscount: 0,
      tipAmount: 0,
      toPay: { original: 0, final: 0 },
      savings: { total: 0, breakdown: [] },
      deliveryEstimate: { minutes: 30, label: 'Delivering in 30 mins' },
      itemCount: 0,
      totals: null,
      fees: [],
      distance: { km: null, label: '', known: false },
      freeDelivery: { enabled: true, threshold: null, unlocked: false, amountToUnlock: 0 },
      platformFee: { amount: 0, isFree: true },
      smallCartFee: { amount: 0, isFree: true },
      totalPayable: 0,
    }
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  _round(value) {
    return Math.round((this._toNumber(value) + Number.EPSILON) * 100) / 100
  }
}
