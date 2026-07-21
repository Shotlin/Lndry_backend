import { logger } from '../../src/config/logger.js'
import { query } from '../../src/config/database.js'
import { AllocationService } from '../../src/modules/allocation/allocation.service.js'
import { AllocationRepository } from '../../src/modules/allocation/allocation.repository.js'

/**
 * Multi-vendor cart service.
 *
 * Cart line item shape (Redis):
 *   { productId, shopId, quantity }
 *
 * Validation rules at addItem and validateCart:
 *   - Shop must be in user's User_Shop_Allocations          (Req 5.2)
 *   - Shop must be active and not soft-deleted              (Req 5.3)
 *   - quantity ≤ vendor_services.stock_quantity               (Req 5.5)
 *   - per-line-item + per-product-in-cart quantity ≤
 *     vendor_services.max_order_qty                            (Req 5.4, 12.2)
 *   - cart never exceeds MAX_CART_ITEMS distinct line items (Req 5.1)
 *
 * Errors are returned as `{ success:false, message, code }` envelopes so
 * callers (controller / OrderSplitter) can render them consistently.
 */
export const MAX_CART_ITEMS = 50

export class CartService {
  constructor(repository, deps = {}) {
    this.repo = repository
    this.allocationService =
      deps.allocationService ||
      new AllocationService(new AllocationRepository())
  }

  // ────────────────────────────────────────────────────────
  // Public read paths
  // ────────────────────────────────────────────────────────

  /**
   * Get an enriched view of the cart for the API.
   */
  async getCart(userId) {
    const cartItems = await this.repo.getCart(userId)
    if (cartItems.length === 0) {
      return this._emptyEnriched(userId)
    }
    return this._enrichCart(userId, cartItems)
  }

  // ────────────────────────────────────────────────────────
  // Identity resolver (Phase 3)
  // ────────────────────────────────────────────────────────

  /**
   * Phase 3: resolve which (productId, shopId, shopProductRow) a cart
   * mutation targets, given any of the three accepted identity inputs:
   *
   *   1. `shopProductId` — exact, used by the new option popup. Resolves
   *      to its productId/shopId via vendor_services lookup, validates
   *      against optional `productId`/`shopId` for conflict detection
   *      (returns CART_ITEM_IDENTITY_CONFLICT if any disagree).
   *   2. `productId` + `shopId` — legacy precise path, unchanged.
   *   3. `productId` only — legacy auto-resolve. Returns
   *      CART_SHOP_REQUIRED when more than one shop in the user's
   *      allocations carries the product.
   *
   * On success the helper returns the same enriched row as
   * `findShopProductForUser` so callers can reuse the existing
   * availability/stock/max-qty validation.
   *
   * @param {string} userId
   * @param {{ productId?: string|null, shopId?: string|null, shopProductId?: string|null }} input
   * @returns {Promise<{success: true, productId: string, shopId: string, sp: object} | {success: false, message: string, code: string, details?: object}>}
   */
  async _resolveCartIdentity(userId, input) {
    const productId = input.productId || null
    const shopId = input.shopId || null
    const shopProductId = input.shopProductId || null

    // Path 1: shopProductId provided
    if (shopProductId) {
      const sp = await this.repo.findShopProductByIdForUser(
        userId,
        shopProductId
      )
      if (!sp) {
        return {
          success: false,
          message: 'This product option is not available to you',
          code: 'SHOP_NOT_AVAILABLE',
        }
      }
      // Conflict detection — caller must not send mismatched legacy ids
      if (productId && productId !== sp.garment_rate_id) {
        return {
          success: false,
          message:
            'productId does not match the provided shopProductId',
          code: 'CART_ITEM_IDENTITY_CONFLICT',
          details: { expected: sp.garment_rate_id, got: productId },
        }
      }
      if (shopId && shopId !== sp.vendor_id) {
        return {
          success: false,
          message: 'shopId does not match the provided shopProductId',
          code: 'CART_ITEM_IDENTITY_CONFLICT',
          details: { expected: sp.vendor_id, got: shopId },
        }
      }
      return {
        success: true,
        productId: sp.garment_rate_id,
        shopId: sp.vendor_id,
        sp,
      }
    }

    if (!productId) {
      return {
        success: false,
        message: 'productId or shopProductId is required',
        code: 'INVALID_REQUEST',
      }
    }

    // Path 2: productId + shopId
    if (shopId) {
      const sp = await this.repo.findShopProductForUser(
        userId,
        productId,
        shopId
      )
      if (!sp) {
        return {
          success: false,
          message: 'This shop is not available to you',
          code: 'SHOP_NOT_AVAILABLE',
        }
      }
      return { success: true, productId, shopId, sp }
    }

    // Path 3: productId only — auto-resolve
    const candidates = await this.repo.findShopProductsForProduct(
      userId,
      productId
    )
    if (candidates.length === 0) {
      // FIX: Distinguish between "product genuinely unavailable" and
      // "user has no allocation yet". Try to auto-assign from default address
      // first, then retry the lookup once.
      const autoAssigned = await this._ensureAllocationFromDefaultAddress(userId)
      if (autoAssigned) {
        const retriedCandidates = await this.repo.findShopProductsForProduct(
          userId,
          productId
        )
        if (retriedCandidates.length === 0) {
          return {
            success: false,
            message: 'Product is not available in your delivery area',
            code: 'SHOP_NOT_AVAILABLE',
          }
        }
        if (retriedCandidates.length > 1) {
          return {
            success: false,
            message: 'Multiple vendors carry this product. Please specify which shop to order from.',
            code: 'CART_SHOP_REQUIRED',
          }
        }
        const resolvedShopIdRetry = retriedCandidates[0].vendor_id
        const spRetry = await this.repo.findShopProductForUser(userId, productId, resolvedShopIdRetry)
        if (!spRetry) {
          return { success: false, message: 'This shop is not available to you', code: 'SHOP_NOT_AVAILABLE' }
        }
        return { success: true, productId, shopId: resolvedShopIdRetry, sp: spRetry }
      }
      // No allocation and no default address — give an actionable message
      return {
        success: false,
        message: 'Please set your delivery address to add items to cart.',
        code: 'SHOP_ALLOCATION_REQUIRED',
      }
    }
    if (candidates.length > 1) {
      return {
        success: false,
        message:
          'Multiple vendors carry this product. Please specify which shop to order from.',
        code: 'CART_SHOP_REQUIRED',
      }
    }
    const resolvedShopId = candidates[0].vendor_id
    const sp = await this.repo.findShopProductForUser(
      userId,
      productId,
      resolvedShopId
    )
    if (!sp) {
      return {
        success: false,
        message: 'This shop is not available to you',
        code: 'SHOP_NOT_AVAILABLE',
      }
    }
    return { success: true, productId, shopId: resolvedShopId, sp }
  }

  // ────────────────────────────────────────────────────────
  // Add / update / remove
  // ────────────────────────────────────────────────────────

  /**
   * Add a product (from a specific shop) to the cart.
   *
   * Phase 3: accepts the new optional `shopProductId` identity in addition
   * to the legacy `productId` (+ optional `shopId`) shape. Identity
   * conflicts (e.g., shopProductId points to a different productId than
   * the caller passed) are rejected with CART_ITEM_IDENTITY_CONFLICT.
   *
   * If `shopId` is omitted (and no shopProductId) the service auto-resolves
   * the shop when there is exactly one available shop for the product
   * across the user's allocations. Multiple vendors → CART_SHOP_REQUIRED.
   */
  async addItem(userId, { productId = null, shopId = null, shopProductId = null, quantity }) {
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      return {
        success: false,
        message: 'Quantity must be a positive integer',
        code: 'INVALID_QUANTITY',
      }
    }

    const resolved = await this._resolveCartIdentity(userId, {
      productId,
      shopId,
      shopProductId,
    })
    if (!resolved.success) return resolved

    const sp = resolved.sp
    const resolvedProductId = resolved.productId
    const resolvedShopId = resolved.shopId

    const shopActive = sp.shop_active === true
    if (!shopActive) {
      return {
        success: false,
        message: 'This shop is currently inactive',
        code: 'SHOP_INACTIVE',
      }
    }

    const productActive = sp.product_active === true
    if (!productActive || sp.is_available !== true) {
      return {
        success: false,
        message: 'This product is currently unavailable',
        code: 'SHOP_PRODUCT_UNAVAILABLE',
      }
    }

    const cartItems = await this.repo.getCart(userId)
    const existingIndex = cartItems.findIndex(
      (i) => i.productId === resolvedProductId && i.shopId === resolvedShopId
    )
    const existingQty = existingIndex >= 0 ? cartItems[existingIndex].quantity : 0
    const newQty = existingQty + qty

    const maxOrderQty = Number(sp.max_order_qty)
    if (newQty > maxOrderQty) {
      return {
        success: false,
        message: `Maximum ${maxOrderQty} units of "${sp.name}" allowed per order`,
        code: 'MAX_QTY_EXCEEDED',
        details: { productId: resolvedProductId, shopId: resolvedShopId, max: maxOrderQty },
      }
    }

    const stockQuantity = Number(sp.stock_quantity)
    if (newQty > stockQuantity) {
      return {
        success: false,
        message: `Only ${stockQuantity} units of "${sp.name}" available`,
        code: 'INSUFFICIENT_STOCK',
        details: {
          productId: resolvedProductId,
          shopId: resolvedShopId,
          available: stockQuantity,
        },
      }
    }

    if (existingIndex >= 0) {
      cartItems[existingIndex].quantity = newQty
    } else {
      if (cartItems.length >= MAX_CART_ITEMS) {
        return {
          success: false,
          message: `Cart is limited to ${MAX_CART_ITEMS} distinct items`,
          code: 'CART_LIMIT_EXCEEDED',
          details: { max: MAX_CART_ITEMS },
        }
      }
      cartItems.push({
        productId: resolvedProductId,
        shopId: resolvedShopId,
        quantity: newQty,
      })
    }

    await this.repo.saveCart(userId, cartItems)
    logger.info(
      {
        userId,
        productId: resolvedProductId,
        shopId: resolvedShopId,
        shopProductId: sp.shop_product_id,
        quantity: newQty,
        action: 'cart_item_added',
      },
      'Cart item added/updated'
    )

    return { success: true, cart: await this._enrichCart(userId, cartItems) }
  }

  /**
   * Update item quantity (absolute, not delta).
   *
   * Phase 3: identifies the line by `(productId, shopId)` or, when the
   * caller passes `shopProductId`, resolves to the exact shop_product
   * row first. Ambiguous matches (productId only, multiple lines) are
   * rejected with CART_ITEM_AMBIGUOUS so we never update sibling options
   * by accident.
   */
  async updateItem(userId, productId, quantity, shopId = null, shopProductId = null) {
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      return {
        success: false,
        message: 'Quantity must be a positive integer',
        code: 'INVALID_QUANTITY',
      }
    }

    // Phase 3: resolve shopProductId → (productId, shopId) for exact match.
    let resolvedProductId = productId
    let resolvedShopId = shopId
    if (shopProductId) {
      const spRow = await this.repo.findShopProductByIdForUser(
        userId,
        shopProductId
      )
      if (!spRow) {
        return {
          success: false,
          message: 'This product option is not available to you',
          code: 'SHOP_NOT_AVAILABLE',
        }
      }
      // Conflict detection vs. legacy ids on the request
      if (productId && productId !== spRow.garment_rate_id) {
        return {
          success: false,
          message: 'productId does not match the provided shopProductId',
          code: 'CART_ITEM_IDENTITY_CONFLICT',
        }
      }
      if (shopId && shopId !== spRow.vendor_id) {
        return {
          success: false,
          message: 'shopId does not match the provided shopProductId',
          code: 'CART_ITEM_IDENTITY_CONFLICT',
        }
      }
      resolvedProductId = spRow.garment_rate_id
      resolvedShopId = spRow.vendor_id
    }

    const cartItems = await this.repo.getCart(userId)
    const matches = cartItems
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => {
        if (item.productId !== resolvedProductId) return false
        if (resolvedShopId && item.shopId !== resolvedShopId) return false
        return true
      })

    if (matches.length === 0) {
      return { success: false, message: 'Item not in cart', code: 'CART_ITEM_NOT_FOUND' }
    }
    if (matches.length > 1) {
      return {
        success: false,
        message:
          'Multiple cart entries match. Please specify shopId or shopProductId.',
        code: 'CART_ITEM_AMBIGUOUS',
      }
    }

    const { item, idx } = matches[0]

    const sp = await this.repo.findShopProductForUser(
      userId,
      item.productId,
      item.shopId
    )
    if (!sp) {
      cartItems.splice(idx, 1)
      await this.repo.saveCart(userId, cartItems)
      return {
        success: false,
        message: 'This shop is no longer available',
        code: 'SHOP_NOT_AVAILABLE',
      }
    }

    if (sp.shop_active !== true) {
      cartItems.splice(idx, 1)
      await this.repo.saveCart(userId, cartItems)
      return {
        success: false,
        message: 'This shop is currently inactive',
        code: 'SHOP_INACTIVE',
      }
    }

    if (sp.product_active !== true || sp.is_available !== true) {
      cartItems.splice(idx, 1)
      await this.repo.saveCart(userId, cartItems)
      return {
        success: false,
        message: 'This product is currently unavailable',
        code: 'SHOP_PRODUCT_UNAVAILABLE',
      }
    }

    const maxOrderQty = Number(sp.max_order_qty)
    if (qty > maxOrderQty) {
      return {
        success: false,
        message: `Maximum ${maxOrderQty} units of "${sp.name}" allowed per order`,
        code: 'MAX_QTY_EXCEEDED',
        details: { productId: item.productId, shopId: item.shopId, max: maxOrderQty },
      }
    }

    const stockQuantity = Number(sp.stock_quantity)
    if (qty > stockQuantity) {
      return {
        success: false,
        message: `Only ${stockQuantity} units of "${sp.name}" available`,
        code: 'INSUFFICIENT_STOCK',
        details: { productId: item.productId, shopId: item.shopId, available: stockQuantity },
      }
    }

    cartItems[idx].quantity = qty
    await this.repo.saveCart(userId, cartItems)

    return { success: true, cart: await this._enrichCart(userId, cartItems) }
  }

  /**
   * Remove an item from the cart, identified by `(productId, shopId)` or
   * by the new optional `shopProductId`. Ambiguous matches are rejected
   * with CART_ITEM_AMBIGUOUS so sibling options are never deleted.
   */
  async removeItem(userId, productId, shopId = null, shopProductId = null) {
    let resolvedProductId = productId
    let resolvedShopId = shopId
    if (shopProductId) {
      const spRow = await this.repo.findShopProductByIdForUser(
        userId,
        shopProductId
      )
      if (!spRow) {
        return {
          success: false,
          message: 'This product option is not available to you',
          code: 'SHOP_NOT_AVAILABLE',
        }
      }
      if (productId && productId !== spRow.garment_rate_id) {
        return {
          success: false,
          message: 'productId does not match the provided shopProductId',
          code: 'CART_ITEM_IDENTITY_CONFLICT',
        }
      }
      if (shopId && shopId !== spRow.vendor_id) {
        return {
          success: false,
          message: 'shopId does not match the provided shopProductId',
          code: 'CART_ITEM_IDENTITY_CONFLICT',
        }
      }
      resolvedProductId = spRow.garment_rate_id
      resolvedShopId = spRow.vendor_id
    }

    const cartItems = await this.repo.getCart(userId)
    const matches = cartItems.filter((i) => {
      if (i.productId !== resolvedProductId) return false
      if (resolvedShopId && i.shopId !== resolvedShopId) return false
      return true
    })

    if (matches.length === 0) {
      return { success: false, message: 'Item not in cart', code: 'CART_ITEM_NOT_FOUND' }
    }
    if (matches.length > 1) {
      return {
        success: false,
        message:
          'Multiple cart entries match. Please specify shopId or shopProductId.',
        code: 'CART_ITEM_AMBIGUOUS',
      }
    }

    const filtered = cartItems.filter((i) => {
      if (i.productId !== resolvedProductId) return true
      if (resolvedShopId && i.shopId !== resolvedShopId) return true
      return false
    })

    await this.repo.saveCart(userId, filtered)
    return { success: true, cart: await this._enrichCart(userId, filtered) }
  }

  /**
   * Clear the entire cart, including extras (tip + delivery instructions).
   * Used by the checkout success path so post-order users do not see stale
   * carts (Requirement 5.6 — atomicity around checkout).
   */
  async clearCart(userId) {
    await this.repo.clearCart(userId)
    await this.repo.clearExtras(userId)
  }

  // ────────────────────────────────────────────────────────
  // Validation — used at checkout (Req 12.3)
  // ────────────────────────────────────────────────────────

  /**
   * Validate the cart against current allocations, shop activity, max_order_qty
   * and stock_quantity. Returns the validated items along with a list of
   * `failed` entries `{ productId, shopId, reason, code }` that the order
   * service surfaces back to the customer (Requirement 5.9).
   *
   * The cart in Redis is rewritten with only the validated items so a
   * subsequent retry by the customer reflects the current reality.
   */
  async validateCart(userId) {
    const cartItems = await this.repo.getCart(userId)
    if (cartItems.length === 0) {
      return {
        valid: false,
        items: [],
        subtotal: 0,
        failed: [],
        warnings: ['Cart is empty'],
        groupedByShop: new Map(),
      }
    }

    const rows = await this.repo.findShopProductsForCart(userId, cartItems)
    const byKey = new Map(
      rows.map((r) => [`${r.garment_rate_id}:${r.vendor_id}`, r])
    )

    const failed = []
    const validItems = []
    let subtotal = 0

    for (const item of cartItems) {
      const sp = byKey.get(`${item.productId}:${item.shopId}`)
      if (!sp) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: 'Shop is not available',
          code: 'SHOP_NOT_AVAILABLE',
        })
        continue
      }

      if (sp.shop_active !== true) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: 'Shop is currently inactive',
          code: 'SHOP_INACTIVE',
        })
        continue
      }

      if (sp.product_active !== true || sp.is_available !== true) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: 'Product is currently unavailable',
          code: 'SHOP_PRODUCT_UNAVAILABLE',
        })
        continue
      }

      const maxOrderQty = Number(sp.max_order_qty)
      if (item.quantity > maxOrderQty) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: `Quantity exceeds the per-order limit of ${maxOrderQty}`,
          code: 'MAX_QTY_EXCEEDED',
          max: maxOrderQty,
        })
        continue
      }

      const stockQuantity = Number(sp.stock_quantity)
      if (item.quantity > stockQuantity) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: `Only ${stockQuantity} units available`,
          code: 'INSUFFICIENT_STOCK',
          available: stockQuantity,
        })
        continue
      }

      const effective = this._effectivePrice(sp)
      const lineTotal = parseFloat((effective * item.quantity).toFixed(2))
      subtotal += lineTotal

      validItems.push(this._formatLine(sp, item, effective, lineTotal))
    }

    // Persist validated items back to Redis (drops failed entries so the
    // user's next view shows the current cart state).
    await this.repo.saveCart(
      userId,
      validItems.map((i) => ({
        productId: i.productId,
        shopId: i.shopId,
        quantity: i.quantity,
      }))
    )

    const groupedByShop = new Map()
    for (const item of validItems) {
      const list = groupedByShop.get(item.shopId)
      if (list) list.push(item)
      else groupedByShop.set(item.shopId, [item])
    }

    return {
      valid: failed.length === 0 && validItems.length > 0,
      items: validItems,
      subtotal: parseFloat(subtotal.toFixed(2)),
      failed,
      warnings: failed.map((f) => f.reason),
      groupedByShop,
    }
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  async _emptyEnriched(userId) {
    const [tipAmount, deliveryInstructions] = await Promise.all([
      this.repo.getTip(userId),
      this.repo.getInstructions(userId),
    ])
    return {
      items: [],
      subtotal: 0,
      count: 0,
      totalMrp: 0,
      totalSavings: 0,
      tipAmount,
      deliveryInstructions,
      shopGroups: [],
    }
  }

  /** Enrich raw cart items with current product data for display. */
  async _enrichCart(userId, cartItems) {
    if (cartItems.length === 0) return this._emptyEnriched(userId)

    const [rows, tipAmount, deliveryInstructions] = await Promise.all([
      this.repo.findShopProductsForCart(userId, cartItems),
      this.repo.getTip(userId),
      this.repo.getInstructions(userId),
    ])
    const byKey = new Map(
      rows.map((r) => [`${r.garment_rate_id}:${r.vendor_id}`, r])
    )

    let subtotal = 0
    let totalMrp = 0
    const items = []

    for (const item of cartItems) {
      const sp = byKey.get(`${item.productId}:${item.shopId}`)
      if (!sp) continue
      if (sp.shop_active !== true) continue
      if (sp.product_active !== true) continue

      const effective = this._effectivePrice(sp)
      const listPrice = this._listPrice(sp)
      const lineTotal = parseFloat((effective * item.quantity).toFixed(2))
      subtotal += lineTotal
      totalMrp += listPrice * item.quantity

      items.push(this._formatLine(sp, item, effective, lineTotal))
    }

    const shopGroups = []
    const grouped = new Map()
    for (const item of items) {
      const arr = grouped.get(item.shopId)
      if (arr) arr.push(item)
      else grouped.set(item.shopId, [item])
    }
    for (const [shopId, shopItems] of grouped) {
      const shopSubtotal = shopItems.reduce(
        (sum, i) => sum + i.lineTotal,
        0
      )
      shopGroups.push({
        shopId,
        shopName: shopItems[0].shopName,
        items: shopItems,
        subtotal: parseFloat(shopSubtotal.toFixed(2)),
        itemCount: shopItems.reduce((n, i) => n + i.quantity, 0),
      })
    }

    const normalizedSubtotal = parseFloat(subtotal.toFixed(2))
    const normalizedMrp = parseFloat(totalMrp.toFixed(2))

    return {
      items,
      subtotal: normalizedSubtotal,
      count: items.reduce((sum, i) => sum + i.quantity, 0),
      totalMrp: normalizedMrp,
      totalSavings: parseFloat((normalizedMrp - normalizedSubtotal).toFixed(2)),
      tipAmount,
      deliveryInstructions,
      shopGroups,
    }
  }

  _effectivePrice(sp) {
    // shop-level override first, falling back to master catalog
    const sale = sp.sp_sale_price ?? sp.product_sale_price
    const list = sp.sp_price ?? sp.product_price
    const price = sale ?? list
    const num = Number(price)
    return Number.isFinite(num) ? num : 0
  }

  _listPrice(sp) {
    const list = sp.sp_price ?? sp.product_price
    const num = Number(list)
    return Number.isFinite(num) ? num : 0
  }

  _formatLine(sp, item, effective, lineTotal) {
    const listPrice = this._listPrice(sp)
    const sale = sp.sp_sale_price ?? sp.product_sale_price
    const salePrice = sale !== null && sale !== undefined ? Number(sale) : null
    const effectivePrice = Number(effective) || 0

    // Phase 3: discount surfaced for the Flutter product card / cart row.
    // Use list price (the canonical "MRP") as the reference so discount
    // amount/percent reflect the visible strikethrough math.
    const discountAmount =
      listPrice > 0 && effectivePrice < listPrice
        ? Number((listPrice - effectivePrice).toFixed(2))
        : 0
    const discountPercent =
      listPrice > 0 && effectivePrice < listPrice
        ? Math.round(((listPrice - effectivePrice) / listPrice) * 100)
        : 0

    // Defensive parsing for JSONB / nullable columns from garment_rates.
    const customBadges = Array.isArray(sp.custom_badges)
      ? sp.custom_badges
      : (typeof sp.custom_badges === 'string'
          ? this._safeParseArray(sp.custom_badges)
          : [])

    return {
      productId: sp.garment_rate_id,
      shopId: sp.vendor_id,
      shopProductId: sp.shop_product_id,
      // Phase 3: option/family/badge metadata for Flutter UI
      productFamilyId: sp.product_family_id || null,
      familyName: sp.family_name || null,
      optionLabel: sp.option_label || null,
      netQuantity: sp.net_quantity || null,
      foodType: sp.food_type || 'NONE',
      originTag: sp.origin_tag || 'NONE',
      customBadges,
      displayDeliveryMinutes:
        sp.display_delivery_minutes !== null && sp.display_delivery_minutes !== undefined
          ? Number(sp.display_delivery_minutes)
          : null,
      shopName: sp.shop_name || null,
      name: sp.name,
      slug: sp.slug,
      price: listPrice,
      originalPrice:
        salePrice !== null && salePrice < listPrice ? listPrice : null,
      salePrice,
      effectivePrice,
      discountAmount,
      discountPercent,
      quantity: item.quantity,
      unit: sp.unit,
      image: sp.thumbnail_url,
      thumbnailUrl: sp.thumbnail_url,
      stockQuantity: Number(sp.stock_quantity),
      maxOrderQty: Number(sp.max_order_qty),
      subtotal: lineTotal,
      lineTotal,
      inStock: Number(sp.stock_quantity) > 0,
      isAvailable: sp.is_available === true,
    }
  }

  /**
   * Defensive JSONB parser for custom_badges in case PG returned a JSON
   * string (unlikely with `JSONB`, but safe). Never throws.
   * @private
   */
  _safeParseArray(value) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * FIX: If a user has no allocation, attempt to auto-assign one from their
   * default address. This unblocks real users who logged in before the
   * auto-assign trigger was added and never got an allocation row.
   *
   * Returns true if allocation was successfully computed (even if 0 vendors
   * were found — the caller handles that gracefully), false if no default
   * address exists or on error.
   *
   * @private
   * @param {string} userId
   * @returns {Promise<boolean>}
   */
  async _ensureAllocationFromDefaultAddress(userId) {
    try {
      // Check if user already has allocations (avoid redundant recompute)
      const existing = await this.allocationService.getShopIdsForUser(userId)
      if (Array.isArray(existing) && existing.length > 0) return true

      // Look up default address
      const { rows } = await query(
        `SELECT lat, lng, pincode FROM addresses
          WHERE user_id = $1 AND is_default = true
            AND lat IS NOT NULL AND lng IS NOT NULL AND pincode IS NOT NULL
          LIMIT 1`,
        [userId]
      )
      if (rows.length === 0) return false

      const addr = rows[0]
      const result = await this.allocationService.computeAndUpsertForUser(userId, {
        lat: Number(addr.lat),
        lng: Number(addr.lng),
        pincode: String(addr.pincode),
      })

      if (result.success) {
        logger.info(
          { userId, shopCount: result.data?.vendors?.length ?? 0, action: 'cart.auto_allocation' },
          'Cart auto-assigned allocation from default address'
        )
        return true
      }
      return false
    } catch (err) {
      logger.warn(
        { userId, err: err.message, action: 'cart.auto_allocation_failed' },
        'Cart auto-allocation attempt failed'
      )
      return false
    }
  }
}
