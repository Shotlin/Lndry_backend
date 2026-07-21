import crypto from 'node:crypto'
import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { generateSlug } from '../../utils/slugify.js'
import { logger } from '../../config/logger.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'

const CACHE_TTL_LIST = 600     // 10 min for lists
const CACHE_TTL_FEATURED = 1800 // 30 min for featured
const CACHE_TTL_DETAIL = 900   // 15 min for single product
const CACHE_VERSION = 'v3'

/**
 * Hash a sorted array of UUIDs to a short stable token suitable for use
 * inside a Redis cache key. We don't need cryptographic strength here —
 * this just keeps two customers with overlapping but non-identical
 * allocations from sharing a cached payload (Requirement 14.7).
 *
 * @param {string[]} ids
 * @returns {string}
 */
function hashShopIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 'empty'
  const sorted = [...ids].sort()
  return crypto
    .createHash('sha1')
    .update(sorted.join(','))
    .digest('hex')
    .slice(0, 12)
}

/**
 * Empty paginated result helper. Used when a customer has zero allocations
 * so we can short-circuit before hitting the repository.
 */
function emptyList(filters) {
  const page = Number(filters?.page) || 1
  const limit = Number(filters?.limit) || 20
  return {
    data: [],
    pagination: { page, limit, total: 0, totalPages: 0 },
  }
}

/**
 * Products service — business logic with Redis caching
 *
 * Customer-facing read paths (`list`, `search`, `getById`, `getBySlug`,
 * `getRelated`, `getPairWith`, `getFeatured`, `getPriceDrops`,
 * `getLastMinute`) accept an optional `customerContext` argument carrying
 * the requesting user's id. When present:
 *   - the service resolves the customer's allocated shop_ids via
 *     AllocationService (Redis-backed, TTL 600s)
 *   - the resolved list is forwarded to the repository which gates each
 *     query on vendor_services + vendors visibility predicates
 *   - cached payloads are scoped to a per-allocation hash so two
 *     customers in different areas never share results
 *
 * Admin / anonymous reads pass `null` and continue to use the legacy
 * unscoped queries — preserving existing API contracts.
 */
export class ProductsService {
  /**
   * @param {import('./garment-types.repository.js').ProductsRepository} repository
   * @param {object} [deps]
   * @param {AllocationService} [deps.allocationService] - Injectable for tests.
   */
  constructor(repository, deps = {}) {
    this.repo = repository
    this.allocationService =
      deps.allocationService ||
      new AllocationService(new AllocationRepository())
  }

  // ────────────────────────────────────────────────────────
  // Allocation resolution + cache key helpers
  // ────────────────────────────────────────────────────────

  /**
   * Resolve the customer's allocated shop_ids. Returns:
   *   - null when no customer context (admin/anonymous → legacy unscoped)
   *   - [] when the customer has zero allocations (caller short-circuits)
   *   - [shopId, ...] otherwise
   *
   * Errors from the allocation service are logged and treated as "no
   * allocations" so a transient Redis/DB hiccup never leaks the full
   * catalog to a customer (fail-closed for visibility, Requirement 1.5).
   *
   * @param {{ userId?: string }|null|undefined} customerContext
   * @returns {Promise<string[]|null>}
   */
  async _resolveAllocatedShopIds(customerContext) {
    if (!customerContext || !customerContext.userId) return null
    try {
      const ids = await this.allocationService.getShopIdsForUser(
        customerContext.userId
      )
      return Array.isArray(ids) ? ids : []
    } catch (err) {
      logger.error(
        {
          customerId: customerContext.userId,
          err: err.message,
          action: 'garment_rates.resolve_allocations',
        },
        'Failed to resolve customer allocations; falling back to empty'
      )
      return []
    }
  }

  /**
   * Build a customer-scoped cache key fragment. Anonymous/admin callers
   * get the literal "anon" so their cached payload remains shared
   * (Requirement 14.7).
   *
   * @param {string[]|null} allocatedShopIds
   * @returns {string}
   */
  _scopeKey(allocatedShopIds) {
    if (!Array.isArray(allocatedShopIds)) return 'anon'
    return `c:${hashShopIds(allocatedShopIds)}`
  }

  /**
   * List garment_rates with filters (cached by filter combination + scope)
   *
   * @param {object} filters
   * @param {{ userId?: string }|null} [customerContext]
   */
  async list(filters, customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      logger.info(
        {
          customerId: customerContext?.userId,
          shopIds: [],
          action: 'garment_rates.list',
        },
        'Customer has no allocated vendors; returning empty product list'
      )
      return emptyList(filters)
    }

    const scope = this._scopeKey(allocatedShopIds)
    const cacheKey = `garment_rates:list:${CACHE_VERSION}:${scope}:${JSON.stringify(filters)}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const result = this._normalizeProductListResult(
      await this.repo.findMany({ ...filters, allocatedShopIds })
    )
    await cacheSet(cacheKey, result, CACHE_TTL_LIST)

    logger.info(
      {
        customerId: customerContext?.userId || null,
        shopIds: Array.isArray(allocatedShopIds) ? allocatedShopIds.length : null,
        action: 'garment_rates.list',
      },
      'Products list served'
    )
    return result
  }

  /**
   * Hybrid search — prefix FTS + ILIKE + fuzzy suggestions
   * Accepts single character queries for instant suggestions
   *
   * @param {string} q
   * @param {object} filters
   * @param {{ userId?: string }|null} [customerContext]
   */
  async search(q, filters, customerContext = null) {
    const trimmed = String(q || '').trim()

    if (!trimmed) {
      return {
        data: [],
        suggestions: [],
        pagination: {
          page: Number(filters?.page) || 1,
          limit: Number(filters?.limit) || 20,
          total: 0,
          totalPages: 0,
        },
      }
    }

    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      logger.info(
        {
          customerId: customerContext?.userId,
          shopIds: [],
          action: 'garment_rates.search',
        },
        'Customer has no allocated vendors; returning empty search'
      )
      return { ...emptyList(filters), suggestions: [] }
    }

    // search queries bypass cache for freshness
    try {
      return this._normalizeProductListResult(
        await this.repo.fullTextSearch(trimmed, { ...filters, allocatedShopIds })
      )
    } catch (err) {
      logger.warn(
        { err: err.message, q: trimmed, action: 'garment_rates.search' },
        'Search query failed, falling back to ILIKE'
      )
      const result = this._normalizeProductListResult(
        await this.repo.findMany({
          ...filters,
          search: trimmed,
          allocatedShopIds,
        })
      )
      return { ...result, suggestions: [] }
    }
  }

  /**
   * Featured garment_rates (cached 30 min)
   *
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getFeatured(customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return []
    }

    const scope = this._scopeKey(allocatedShopIds)
    const cacheKey = `garment_rates:featured:${CACHE_VERSION}:${scope}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const garment_rates = this._normalizeProducts(
      await this.repo.findFeatured(20, allocatedShopIds)
    )
    await cacheSet(cacheKey, garment_rates, CACHE_TTL_FEATURED)
    return garment_rates
  }

  /**
   * Get single product detail
   *
   * @param {string} id
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getById(id, customerContext = null, viewerUserId = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return null
    }

    const scope = this._scopeKey(allocatedShopIds)
    const cacheKey = `garment_rates:detail:${CACHE_VERSION}:${scope}:${id}`
    const cached = await cacheGet(cacheKey)
    const product = cached
      ? cached
      : this._normalizeProduct(await this.repo.findById(id, allocatedShopIds))
    if (!product) {
      return null
    }
    if (!cached) {
      await cacheSet(cacheKey, product, CACHE_TTL_DETAIL)
    }

    // Attach per-user supplying-store info OUTSIDE the cache so it always
    // reflects the current address/allocation (not shared across users).
    // Uses the viewer's id directly so it works for any authenticated viewer,
    // including the demo/RIDER test account, without affecting catalog scoping.
    const resolvedViewerId = viewerUserId || customerContext?.userId || null
    const store = await this._resolveStoreInfo(resolvedViewerId, product.id)
    return store ? { ...product, store } : product
  }

  /**
   * Resolve the supplying-store block for a product detail response.
   * Returns null when there is no authenticated viewer.
   *
   * Shape (camelCase for the Flutter client):
   *   { shopId, shopName, shopProductId, isAvailableAtSelectedLocation,
   *     availabilityReason, selectedPincode, stockStatus }
   *
   * @param {string|null} viewerUserId
   * @param {string} productId
   * @private
   */
  async _resolveStoreInfo(viewerUserId, productId) {
    const userId = viewerUserId
    if (!userId) return null

    try {
      const [supplier, selectedPincode] = await Promise.all([
        this.repo.findSupplyingShopForUser(userId, productId),
        this.repo.findSelectedPincodeForUser(userId),
      ])

      if (!supplier) {
        return {
          shopId: null,
          shopName: null,
          shopProductId: null,
          isAvailableAtSelectedLocation: false,
          availabilityReason: 'PRODUCT_NOT_ASSIGNED_TO_STORE',
          selectedPincode,
          stockStatus: 'unavailable',
        }
      }

      const inAllocation = supplier.in_allocation === true
      const hasStock = Number(supplier.stock_quantity) > 0
      const isAvailable =
        inAllocation && supplier.is_available === true && hasStock

      let availabilityReason = 'AVAILABLE'
      if (!inAllocation) {
        availabilityReason = 'PRODUCT_UNAVAILABLE_AT_LOCATION'
      } else if (supplier.is_available !== true) {
        availabilityReason = 'PRODUCT_UNAVAILABLE_AT_LOCATION'
      } else if (!hasStock) {
        availabilityReason = 'PRODUCT_OUT_OF_STOCK'
      }

      return {
        shopId: supplier.vendor_id,
        shopName: supplier.shop_name,
        shopProductId: supplier.shop_product_id,
        isAvailableAtSelectedLocation: isAvailable,
        availabilityReason,
        selectedPincode,
        stockStatus: hasStock ? 'in_stock' : 'out_of_stock',
      }
    } catch (err) {
      logger.warn(
        { productId, userId, err: err.message, action: 'garment_rates.store_info_failed' },
        'Failed to resolve supplying-store info for product detail'
      )
      return null
    }
  }

  /**
   * Get product by slug (public-facing)
   *
   * @param {string} slug
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getBySlug(slug, customerContext = null, viewerUserId = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return null
    }

    const scope = this._scopeKey(allocatedShopIds)
    const cacheKey = `garment_rates:slug:${CACHE_VERSION}:${scope}:${slug}`
    const cached = await cacheGet(cacheKey)
    const product = cached
      ? cached
      : this._normalizeProduct(await this.repo.findBySlug(slug, allocatedShopIds))
    if (!product) {
      return null
    }
    if (!cached) {
      await cacheSet(cacheKey, product, CACHE_TTL_DETAIL)
    }

    const resolvedViewerId = viewerUserId || customerContext?.userId || null
    const store = await this._resolveStoreInfo(resolvedViewerId, product.id)
    return store ? { ...product, store } : product
  }

  /**
   * Get product by ID or slug (auto-detect)
   *
   * @param {string} identifier
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getByIdOrSlug(identifier, customerContext = null, viewerUserId = null) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)
    return isUUID
      ? this.getById(identifier, customerContext, viewerUserId)
      : this.getBySlug(identifier, customerContext, viewerUserId)
  }

  /**
   * Get related garment_rates (same category)
   *
   * @param {string} id
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getRelated(id, customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return []
    }

    // Look up the master-catalog row directly (admin scope) so we can read
    // its category_id; visibility is enforced separately by findRelated.
    const product = await this.repo.findById(id)
    if (!product) return null

    return this._normalizeProducts(
      await this.repo.findRelated(id, product.category_id, 10, allocatedShopIds)
    )
  }

  async getPairWith(productId, categoryId, limit = 10, customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return []
    }

    return this._normalizeProducts(
      await this.repo.findPairWith(productId, categoryId, limit, allocatedShopIds)
    )
  }

  /**
   * Get all purchasable options for a product's family (cached 15 min)
   *
   * @param {string} productId
   * @param {{ userId?: string }|null} [customerContext]
   */
  async getProductOptions(productId, customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return null
    }

    const scope = this._scopeKey(allocatedShopIds)
    const cacheKey = `garment_rates:options:${CACHE_VERSION}:${scope}:${productId}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const result = await this.repo.findFamilyOptions(productId, allocatedShopIds)
    if (!result) return null

    // Normalize image URLs on options
    const normalized = {
      family: result.family,
      options: this._normalizeProducts(result.options),
    }

    await cacheSet(cacheKey, normalized, CACHE_TTL_DETAIL)
    return normalized
  }

  async getPriceDrops(limit = 10, customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return []
    }

    return this._normalizeProducts(
      await this.repo.getPriceDrops(limit, allocatedShopIds)
    )
  }

  async getLastMinute(limit = 10, customerContext = null) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)

    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return []
    }

    return this._normalizeProducts(
      await this.repo.getLastMinute(limit, allocatedShopIds)
    )
  }

  /**
   * Create product [ADMIN]
   */
  async create(data) {
    const productData = {
      ...data,
      slug: generateSlug(data.name),
    }

    const product = await this.repo.create(productData)

    // Invalidate list/featured caches
    await cacheDeletePattern('garment_rates:list:*')
    await cacheDeletePattern('garment_rates:featured*')
    logger.info({ productId: product.id, action: 'garment_rates.create' }, 'Product created')

    return { success: true, product: this._normalizeProduct(product) }
  }

  /**
   * Update product [ADMIN]
   */
  async update(id, data) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Product not found' }

    const updateData = { ...data }

    // Re-generate slug if name changed
    if (updateData.name && updateData.name !== existing.name) {
      updateData.slug = generateSlug(updateData.name)
    }

    const product = await this.repo.update(id, updateData)

    await cacheDeletePattern('garment_rates:*')
    logger.info({ productId: id, action: 'garment_rates.update' }, 'Product updated')

    return { success: true, product: this._normalizeProduct(product) }
  }

  /**
   * Update stock [ADMIN]
   */
  async updateStock(id, stock) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Product not found' }

    const product = await this.repo.updateStock(id, stock)

    await cacheDeletePattern(`garment_rates:detail:*:${id}`)
    await cacheDeletePattern('garment_rates:list:*')

    return { success: true, product }
  }

  /**
   * Delete product [ADMIN]
   */
  async delete(id) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Garment type not found' }

    try {
      await this.repo.delete(id)
      await cacheDeletePattern('garment_rates:*')
      logger.info({ productId: id, action: 'garment_rates.delete' }, 'Product deleted')
      return { success: true }
    } catch (err) {
      logger.error({ err, productId: id }, 'Failed to delete garment type')
      if (err.code === '23503') {
        return { 
          success: false, 
          message: 'Cannot delete garment type because it is referenced by existing orders, stock movements, or vendor services.' 
        }
      }
      return { success: false, message: err.message || 'Database error occurred during deletion' }
    }
  }

  _normalizeProductListResult(result) {
    if (!result) return result

    return {
      ...result,
      data: this._normalizeProducts(result.data),
      suggestions: this._normalizeProducts(result.suggestions),
    }
  }

  _normalizeProducts(garment_rates = []) {
    return garment_rates.map((product) => this._normalizeProduct(product))
  }

  _normalizeProduct(product) {
    if (!product) return product

    return {
      ...product,
      thumbnail_url: normalizeCloudinaryDeliveryUrl(product.thumbnail_url, 'default'),
      images: Array.isArray(product.images)
        ? product.images.map((image) => normalizeCloudinaryDeliveryUrl(image, 'default'))
        : product.images,
    }
  }
}
