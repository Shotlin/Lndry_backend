import { query } from '../../config/database.js'

function emptyPagination(page, limit) {
  return {
    data: [],
    pagination: {
      page,
      limit,
      total: 0,
      totalPages: 0,
    },
  }
}

function normalizeSearchTerms(q) {
  return String(q || '')
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean)
}

/**
 * Customer-scoped visibility predicate (Requirements 1.5, 4.5, 11.5, 14.7).
 *
 * When an `allocatedShopIds` array is provided the predicate gates each
 * product on the existence of at least one vendor_services row that:
 *   - belongs to a shop in the customer's User_Shop_Allocations
 *   - has is_available = true and deleted_at IS NULL
 *   - is on a shop with is_active = true and deleted_at IS NULL
 *
 * The helper appends to the existing `params` array and returns the SQL
 * snippet plus the next placeholder index. Callers that don't want
 * customer scoping (admin queries, anonymous browsing) pass `null` and
 * receive an empty snippet so the master-catalog SQL is unchanged.
 *
 * Implementation notes:
 *   - Uses idx_shop_products_shop_available (vendor_id, is_available)
 *     and the garment_rates PK on `id` for the EXISTS lookup.
 *   - Casts $N::uuid[] so PostgreSQL can use the GIN-friendly array path
 *     without per-row casts on the inner query.
 *   - Only $-placeholder *numbers* are spliced into the returned string;
 *     all user-supplied values continue through the pg parameter bindings.
 *
 * @param {string[]|null} allocatedShopIds
 * @param {any[]} params - Mutated; the array of $-placeholder values.
 * @param {number} startIdx - Next available $-placeholder index.
 * @returns {{ sql: string, nextIdx: number }}
 */
function buildCustomerVisibilitySnippet(allocatedShopIds, params, startIdx) {
  if (!Array.isArray(allocatedShopIds)) {
    return { sql: '', nextIdx: startIdx }
  }
  // Empty allocations → caller is expected to short-circuit; we still emit a
  // predicate that matches no rows in case we get here defensively.
  if (allocatedShopIds.length === 0) {
    return { sql: 'AND FALSE', nextIdx: startIdx }
  }
  params.push(allocatedShopIds)
  const idx = startIdx
  return {
    sql: `AND EXISTS (
      SELECT 1
        FROM vendor_services sp
        JOIN vendors s ON s.id = sp.vendor_id
       WHERE sp.garment_rate_id = p.id
         AND sp.vendor_id = ANY($${idx}::uuid[])
         AND sp.is_available = true
         AND sp.deleted_at IS NULL
         AND s.is_active = true
         AND s.deleted_at IS NULL
    )`,
    nextIdx: startIdx + 1,
  }
}

/**
 * Products repository — all SQL queries for garment_rates
 * NEVER uses SELECT * — always named columns
 *
 * Customer-facing read paths accept an optional `allocatedShopIds` array
 * that gates product visibility on the customer's User_Shop_Allocations
 * (Requirements 1.5, 4.5, 11.5). Admin/anonymous callers pass `null` to
 * preserve the legacy unscoped behaviour.
 */
export class ProductsRepository {
  /**
   * List garment_rates with filtering, sorting, pagination
   *
   * @param {object} filters
   * @param {string[]|null} [filters.allocatedShopIds] - When set, restrict
   *   results to garment_rates available in at least one allocated shop.
   */
  async findMany({
    page = 1,
    limit = 20,
    category,
    search,
    status,
    sort,
    minPrice,
    maxPrice,
    inStock,
    allocatedShopIds = null,
    groupOptions = false,
  }) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = []
    let paramIdx = 1

    // Status filter (for admin dashboard)
    if (status === 'active') {
      conditions.push('p.is_active = true')
    } else if (status === 'inactive') {
      conditions.push('p.is_active = false')
    } else if (status === 'out_of_stock') {
      conditions.push('p.stock_quantity = 0')
    } else if (status === 'low_stock') {
      conditions.push('p.stock_quantity > 0 AND p.stock_quantity <= p.low_stock_threshold')
    }

    if (category) {
      conditions.push(`p.category_id = $${paramIdx++}`)
      params.push(category)
    }

    if (search) {
      conditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx} OR p.barcode ILIKE $${paramIdx})`)
      params.push(`%${search}%`)
      paramIdx++
    }

    if (inStock === true || inStock === 'true') {
      conditions.push('p.stock_quantity > 0')
    } else if (inStock === false || inStock === 'false') {
      conditions.push('p.stock_quantity = 0')
    }

    // Customer scoping (Req 1.5, 4.5, 11.5)
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      paramIdx
    )
    if (visibility.sql) {
      // Strip the leading "AND " — we add it back via the conditions join
      conditions.push(visibility.sql.replace(/^AND\s+/, ''))
      paramIdx = visibility.nextIdx
    }

    const sortMap = {
      price_asc: 'p.created_at DESC',
      price_desc: 'p.created_at DESC',
      newest: 'p.created_at DESC',
      popular: 'p.total_sold DESC',
      name_asc: 'p.name ASC',
      name_desc: 'p.name DESC',
      stock_asc: 'p.stock_quantity ASC',
    }
    const orderBy = sortMap[sort] || 'p.created_at DESC'
    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1'

    // option_count: number of active siblings in same family (or 1 if standalone)
    const optionCountExpr = `COALESCE(
      (SELECT COUNT(*)::int FROM garment_types sib
       WHERE sib.product_family_id = p.product_family_id
         AND sib.product_family_id IS NOT NULL
         AND sib.is_active = true), 1)`

    if (groupOptions) {
      // When grouping, pick one representative per product_family_id:
      // prefer is_default_option, then lowest option_sort_order, then lowest price.
      // Standalone garment_rates (NULL family) always appear.
      const { rows } = await query(
        `WITH ranked AS (
          SELECT
            p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price, p.cost_price,
            p.stock_quantity, p.unit, (p.images->>0) AS thumbnail_url,
            p.is_active, p.is_featured, p.total_sold,
            p.sku, p.barcode, p.low_stock_threshold, p.category_id,
            p.product_family_id, p.option_label, p.option_sort_order,
            p.is_default_option, p.food_type, p.origin_tag,
            p.custom_badges, p.display_delivery_minutes,
            p.avg_rating, p.rating_count, p.net_quantity,
            p.created_at,
            c.name AS category_name,
            pf.name AS family_name,
            ${optionCountExpr} AS option_count,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(p.product_family_id, p.id)
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC
            ) AS rn
          FROM garment_types p
          LEFT JOIN service_categories c ON c.id = p.category_id
          LEFT JOIN product_families pf ON pf.id = p.product_family_id
          WHERE ${where}
        )
        SELECT id, name, slug, price, sale_price, cost_price,
               stock_quantity, unit, thumbnail_url,
               is_active, is_featured, total_sold,
               sku, barcode, low_stock_threshold, category_id,
               product_family_id, option_label, option_sort_order,
               is_default_option, food_type, origin_tag,
               custom_badges, display_delivery_minutes,
               avg_rating, rating_count, net_quantity,
               category_name, family_name, option_count
        FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy.replace(/p\./g, '')}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      )

      const { rows: countRows } = await query(
        `WITH ranked AS (
          SELECT p.id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(p.product_family_id, p.id)
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC
            ) AS rn
          FROM garment_types p
          WHERE ${where}
        )
        SELECT COUNT(*)::int AS total FROM ranked WHERE rn = 1`,
        params
      )

      return {
        data: rows,
        pagination: {
          page,
          limit,
          total: countRows[0]?.total || 0,
          totalPages: Math.ceil((countRows[0]?.total || 0) / limit),
        },
      }
    }

    const { rows } = await query(
      `SELECT
        p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price, p.cost_price,
        p.stock_quantity, p.unit, (p.images->>0) AS thumbnail_url,
        p.is_active, p.is_featured, p.total_sold,
        p.sku, p.barcode, p.low_stock_threshold, p.category_id,
        p.product_family_id, p.option_label, p.option_sort_order,
        p.is_default_option, p.food_type, p.origin_tag,
        p.custom_badges, p.display_delivery_minutes,
        p.avg_rating, p.rating_count, p.net_quantity,
        c.name AS category_name,
        pf.name AS family_name,
        ${optionCountExpr} AS option_count
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM garment_types p WHERE ${where}`,
      params
    )

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total: countRows[0]?.total || 0,
        totalPages: Math.ceil((countRows[0]?.total || 0) / limit),
      },
    }
  }

  /**
   * Hybrid search: prefix full-text (simple dictionary) + ILIKE fallback
   * Uses 'simple' dictionary so prefix queries like 'amu:*' match 'amul'
   * without English stemming issues. Returns fuzzy suggestions when 0 results.
   *
   * @param {string} q
   * @param {object} filters
   * @param {string[]|null} [filters.allocatedShopIds]
   */
  async fullTextSearch(q, { page = 1, limit = 20, allocatedShopIds = null }) {
    const offset = (page - 1) * limit
    const trimmed = String(q || '').trim()
    const searchTerms = normalizeSearchTerms(trimmed)

    if (!trimmed || searchTerms.length === 0) {
      return { ...emptyPagination(page, limit), suggestions: [] }
    }

    const prefixTsQuery = searchTerms.map((term) => `${term}:*`).join(' & ')
    const likePattern = `%${trimmed}%`

    const params = [prefixTsQuery, likePattern]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const visClause = visibility.sql

    // $1 = prefixTsQuery, $2 = likePattern, optional $3 = shop_ids,
    // then limit + offset.
    const limitIdx = visibility.nextIdx
    const offsetIdx = visibility.nextIdx + 1

    const sql = `
      WITH fts AS (
        SELECT
          p.id,
          p.name,
          p.slug,
          NULL::numeric AS price,
          NULL::numeric AS sale_price,
          p.stock_quantity,
          p.unit,
          NULL::text AS thumbnail_url,
          c.name AS category_name,
          p.is_featured,
          p.total_sold,
          p.product_family_id, p.option_label, p.option_sort_order,
          p.is_default_option, p.food_type, p.origin_tag,
          p.custom_badges, p.display_delivery_minutes,
          p.avg_rating, p.rating_count, p.net_quantity,
          pf.name AS family_name,
          ts_rank(p.search_vector, to_tsquery('simple', $1)) AS rank,
          1 AS source
        FROM garment_types p
        LEFT JOIN service_categories c ON c.id = p.category_id
        LEFT JOIN product_families pf ON pf.id = p.product_family_id
        WHERE p.is_active = true
          AND p.search_vector @@ to_tsquery('simple', $1)
          ${visClause}
      ),
      ilike_fallback AS (
        SELECT
          p.id,
          p.name,
          p.slug,
          NULL::numeric AS price,
          NULL::numeric AS sale_price,
          p.stock_quantity,
          p.unit,
          NULL::text AS thumbnail_url,
          c.name AS category_name,
          p.is_featured,
          p.total_sold,
          p.product_family_id, p.option_label, p.option_sort_order,
          p.is_default_option, p.food_type, p.origin_tag,
          p.custom_badges, p.display_delivery_minutes,
          p.avg_rating, p.rating_count, p.net_quantity,
          pf.name AS family_name,
          0.1 AS rank,
          2 AS source
        FROM garment_types p
        LEFT JOIN service_categories c ON c.id = p.category_id
        LEFT JOIN product_families pf ON pf.id = p.product_family_id
        WHERE p.is_active = true
          AND p.id NOT IN (SELECT id FROM fts)
          AND (
            p.name ILIKE $2
            OR p.sku ILIKE $2
            OR p.barcode ILIKE $2
          )
          ${visClause}
      ),
      combined AS (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM ilike_fallback
      )
      SELECT
        id,
        name,
        slug,
        price,
        sale_price,
        stock_quantity,
        unit,
        thumbnail_url,
        category_name,
        is_featured,
        total_sold,
        product_family_id, option_label, option_sort_order,
        is_default_option, food_type, origin_tag,
        custom_badges, display_delivery_minutes,
        avg_rating, rating_count, net_quantity,
        family_name,
        rank
      FROM combined
      ORDER BY source ASC, rank DESC, total_sold DESC, name ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `

    const countSql = `
      SELECT COUNT(DISTINCT id)::int AS total
      FROM (
        SELECT p.id
        FROM garment_types p
        WHERE p.is_active = true
          AND p.search_vector @@ to_tsquery('simple', $1)
          ${visClause}
        UNION
        SELECT p.id
        FROM garment_types p
        WHERE p.is_active = true
          AND (
            p.name ILIKE $2
            OR p.sku ILIKE $2
            OR p.barcode ILIKE $2
          )
          ${visClause}
      ) AS matches
    `

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(sql, [...params, limit, offset]),
      query(countSql, params),
    ])

    const total = countRows[0]?.total || 0

    // When no exact/prefix results, provide fuzzy nearest-match suggestions.
    // Suggestions inherit the same allocation scoping so customers never
    // see suggestions for garment_rates outside their allocated vendors.
    let suggestions = []
    if (rows.length === 0 && trimmed.length >= 2) {
      suggestions = await this.fuzzySuggest(trimmed, 6, allocatedShopIds)
    }

    return {
      data: rows,
      suggestions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  /**
   * Fuzzy suggestions using pg_trgm similarity.
   * Returns nearest garment_rates when exact/prefix search finds nothing.
   * Requires: CREATE EXTENSION pg_trgm (migration 017)
   *
   * @param {string} q
   * @param {number} [limit=6]
   * @param {string[]|null} [allocatedShopIds]
   */
  async fuzzySuggest(q, limit = 6, allocatedShopIds = null) {
    try {
      const params = [q]
      const visibility = buildCustomerVisibilitySnippet(
        allocatedShopIds,
        params,
        params.length + 1
      )
      params.push(limit)
      const limitIdx = visibility.nextIdx

      const { rows } = await query(
        `SELECT p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price,
                p.stock_quantity, p.unit, NULL::text AS thumbnail_url,
                c.name AS category_name,
                p.is_featured, p.total_sold,
                similarity(p.name, $1) AS sim
         FROM garment_types p
         LEFT JOIN service_categories c ON c.id = p.category_id
         WHERE p.is_active = true
           AND similarity(p.name, $1) > 0.08
           ${visibility.sql}
         ORDER BY sim DESC, p.total_sold DESC
         LIMIT $${limitIdx}`,
        params
      )
      return rows
    } catch {
      // pg_trgm not available — return empty gracefully
      return []
    }
  }

  /**
   * Get featured/bestseller garment_rates
   *
   * @param {number} [limit=20]
   * @param {string[]|null} [allocatedShopIds]
   */
  async findFeatured(limit = 20, allocatedShopIds = null) {
    const params = []
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    params.push(limit)
    const limitIdx = visibility.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.stock_quantity, p.unit, NULL::text AS thumbnail_url,
              c.name AS category_name, p.total_sold,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              p.avg_rating, p.rating_count, p.net_quantity,
              pf.name AS family_name,
              COALESCE(
                (SELECT COUNT(*)::int FROM garment_types sib
                 WHERE sib.product_family_id = p.product_family_id
                   AND sib.product_family_id IS NOT NULL
                   AND sib.is_active = true), 1) AS option_count
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       WHERE p.is_active = true AND p.is_featured = true
         ${visibility.sql}
       ORDER BY p.total_sold DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Resolve the best supplying shop for a product for a given customer.
   *
   * Prefers a shop in the customer's allocation (so the product can actually
   * be delivered), falling back to ANY active shop that carries it so the UI
   * can show "Sold by {storeName} — not available for delivery to {pincode}".
   *
   * @param {string} userId
   * @param {string} productId
   * @returns {Promise<{
   *   shop_product_id: string, vendor_id: string, shop_name: string,
   *   is_available: boolean, stock_quantity: number, in_allocation: boolean
   * }|null>}
   */
  async findSupplyingShopForUser(userId, productId) {
    const { rows } = await query(
      `SELECT sp.id            AS shop_product_id,
              sp.vendor_id,
              s.name           AS shop_name,
              sp.is_available,
              sp.stock_quantity,
              (a.user_id IS NOT NULL) AS in_allocation
         FROM vendor_services sp
         JOIN vendors s ON s.id = sp.vendor_id
         LEFT JOIN user_shop_allocations a
                ON a.vendor_id = sp.vendor_id
               AND a.user_id = $1
        WHERE sp.garment_rate_id = $2
          AND sp.deleted_at IS NULL
          AND s.is_active = true
          AND s.deleted_at IS NULL
        ORDER BY (a.user_id IS NOT NULL) DESC,
                 a.is_primary DESC NULLS LAST,
                 sp.is_available DESC,
                 sp.stock_quantity DESC
        LIMIT 1`,
      [userId, productId]
    )
    return rows[0] || null
  }

  /**
   * Returns the customer's currently-selected delivery pincode (default
   * address first, else most recently updated). Null when no address exists.
   *
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async findSelectedPincodeForUser(userId) {
    const { rows } = await query(
      `SELECT pincode
         FROM addresses
        WHERE user_id = $1
        ORDER BY is_default DESC, updated_at DESC
        LIMIT 1`,
      [userId]
    )
    const pincode = rows[0]?.pincode
    return pincode ? String(pincode).trim() : null
  }

  /**
   * Get single product with full details
   *
   * @param {string} id
   * @param {string[]|null} [allocatedShopIds] - Customer scoping; when set
   *   the product is only returned if at least one allocated shop carries it.
   */
  async findById(id, allocatedShopIds = null) {
    const params = [id]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, NULL::text AS description, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.cost_price, p.category_id, p.stock_quantity, p.unit,
              (p.images->>0) AS thumbnail_url, p.images, p.tags, p.is_active,
              p.is_featured, p.total_sold,
              p.sku, p.barcode, p.low_stock_threshold, p.max_order_qty,
              p.ingredients, p.allergen_info, p.shelf_life, p.storage_instructions,
              p.certifications, p.nutrition_info,
              p.meta_title, p.meta_description,
              p.brand, p.brand_logo_url, p.net_quantity, p.highlights, p.attributes,
              p.vendor_name, p.vendor_address, p.vendor_fssai, p.return_policy,
              p.avg_rating, p.rating_count, p.is_authentic,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              c.name AS category_name,
              pf.name AS family_name,
              COALESCE(
                (SELECT COUNT(*)::int FROM garment_types sib
                 WHERE sib.product_family_id = p.product_family_id
                   AND sib.product_family_id IS NOT NULL
                   AND sib.is_active = true), 1) AS option_count,
              (SELECT json_agg(v) FROM product_variants v WHERE v.garment_rate_id = p.id) AS variants,
              p.created_at, p.updated_at
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       WHERE p.id = $1
         ${visibility.sql}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Get product by slug (public-facing)
   *
   * @param {string} slug
   * @param {string[]|null} [allocatedShopIds]
   */
  async findBySlug(slug, allocatedShopIds = null) {
    const params = [slug]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, NULL::text AS description, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.cost_price, p.category_id, p.stock_quantity, p.unit,
              (p.images->>0) AS thumbnail_url, p.images, p.tags, p.is_active,
              p.is_featured, p.total_sold,
              p.sku, p.barcode, p.low_stock_threshold, p.max_order_qty,
              p.ingredients, p.allergen_info, p.shelf_life, p.storage_instructions,
              p.certifications, p.nutrition_info,
              p.meta_title, p.meta_description,
              p.brand, p.brand_logo_url, p.net_quantity, p.highlights, p.attributes,
              p.vendor_name, p.vendor_address, p.vendor_fssai, p.return_policy,
              p.avg_rating, p.rating_count, p.is_authentic,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              c.name AS category_name,
              pf.name AS family_name,
              COALESCE(
                (SELECT COUNT(*)::int FROM garment_types sib
                 WHERE sib.product_family_id = p.product_family_id
                   AND sib.product_family_id IS NOT NULL
                   AND sib.is_active = true), 1) AS option_count,
              (SELECT json_agg(v) FROM product_variants v WHERE v.garment_rate_id = p.id) AS variants,
              p.created_at, p.updated_at
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       WHERE p.slug = $1 AND p.is_active = true
         ${visibility.sql}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Get related garment_rates (same category, excluding current)
   *
   * @param {string} productId
   * @param {string} categoryId
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   */
  async findRelated(productId, categoryId, limit = 10, allocatedShopIds = null) {
    const params = [categoryId, productId]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    params.push(limit)
    const limitIdx = visibility.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.stock_quantity, p.unit, NULL::text AS thumbnail_url, p.total_sold,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              p.avg_rating, p.rating_count, p.net_quantity,
              pf.name AS family_name
       FROM garment_types p
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       WHERE p.is_active = true
         AND p.category_id = $1
         AND p.id != $2
         ${visibility.sql}
       ORDER BY p.total_sold DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  async findPairWith(productId, categoryId, limit = 10, allocatedShopIds = null) {
    const params = [categoryId, productId]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    params.push(limit)
    const limitIdx = visibility.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.stock_quantity, p.unit, NULL::text AS thumbnail_url,
              p.brand, p.total_sold, p.avg_rating, p.rating_count,
              c.name AS category_name,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              p.net_quantity,
              pf.name AS family_name
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       WHERE p.is_active = true
         AND p.category_id != $1
         AND p.id != $2
         ${visibility.sql}
       ORDER BY p.total_sold DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Find all purchasable options for a product's family.
   *
   * @param {string} productId
   * @param {string[]|null} [allocatedShopIds] - Customer shop scoping
   * @returns {{ family: object|null, options: object[] }}
   */
  async findFamilyOptions(productId, allocatedShopIds = null) {
    // 1. Look up the product's family
    const { rows: productRows } = await query(
      `SELECT p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.stock_quantity, p.unit, NULL::text AS thumbnail_url,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              p.avg_rating, p.rating_count, p.net_quantity,
              p.category_id, p.is_active
       FROM garment_types p
       WHERE p.id = $1`,
      [productId]
    )

    if (productRows.length === 0) return null

    const product = productRows[0]
    const familyId = product.product_family_id

    // 2. If no family, return just this product as a single option
    if (!familyId) {
      const option = { ...product }
      // Enrich with shop data if customer context
      if (Array.isArray(allocatedShopIds) && allocatedShopIds.length > 0) {
         const shopData = await this._fetchShopDataForProducts([product.id], allocatedShopIds)
         if (shopData[product.id]) {
           Object.assign(option, shopData[product.id])
         }
      }
      return {
        family: null,
        options: [option],
      }
    }

    // 3. Get family info
    const { rows: familyRows } = await query(
      `SELECT id, name, slug, description FROM product_families WHERE id = $1`,
      [familyId]
    )
    const family = familyRows[0] || null

    // 4. Get all active garment_rates in the family
    const { rows: options } = await query(
      `SELECT p.id, p.name, p.slug, NULL::numeric AS price, NULL::numeric AS sale_price,
              p.stock_quantity, p.unit, NULL::text AS thumbnail_url,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag,
              p.custom_badges, p.display_delivery_minutes,
              p.avg_rating, p.rating_count, p.net_quantity,
              p.category_id
       FROM garment_types p
       WHERE p.product_family_id = $1
         AND p.is_active = true
       ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.name ASC`,
      [familyId]
    )

    // 5. Enrich with shop data if customer context
    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length > 0) {
      const productIds = options.map(o => o.id)
      const shopData = await this._fetchShopDataForProducts(productIds, allocatedShopIds)

      // Filter out options with no available shop_product and enrich the rest
      const enrichedOptions = options
        .filter(o => shopData[o.id])
        .map(o => ({ ...o, ...shopData[o.id] }))

      return { family, options: enrichedOptions }
    }

    return { family, options }
  }

  /**
   * Batch-fetch best shop_product data for a list of product IDs.
   * Returns a map of productId → shop data object.
   *
   * @param {string[]} productIds
   * @param {string[]} shopIds
   * @returns {Promise<Record<string, object>>}
   */
  async _fetchShopDataForProducts(productIds, shopIds) {
    if (!productIds.length || !shopIds.length) return {}

    const { rows } = await query(
      `SELECT DISTINCT ON (sp.garment_rate_id)
        sp.garment_rate_id, sp.id AS shop_product_id, sp.vendor_id,
        sp.price AS sp_price, sp.sale_price AS sp_sale_price,
        sp.stock_quantity, sp.max_order_qty, sp.is_available
      FROM vendor_services sp
      JOIN vendors s ON s.id = sp.vendor_id
      WHERE sp.garment_rate_id = ANY($1::uuid[])
        AND sp.vendor_id = ANY($2::uuid[])
        AND sp.is_available = true
        AND sp.deleted_at IS NULL
        AND s.is_active = true
        AND s.deleted_at IS NULL
      ORDER BY sp.garment_rate_id, sp.stock_quantity DESC`,
      [productIds, shopIds]
    )

    const map = {}
    for (const row of rows) {
      map[row.garment_rate_id] = {
        shop_product_id: row.shop_product_id,
        vendor_id: row.vendor_id,
        sp_price: row.sp_price,
        sp_sale_price: row.sp_sale_price,
        sp_stock_quantity: row.stock_quantity,
        sp_max_order_qty: row.max_order_qty,
        sp_is_available: row.is_available,
      }
    }
    return map
  }

  /**
   * Create a new product
   */
  async create(data) {
    // garment_types has no thumbnail_url column (dropped by migration 062) —
    // a single thumbnailUrl from the admin form is stored as the first
    // element of the images array, and read back out the same way.
    const images = Array.isArray(data.images) ? [...data.images] : []
    if (data.thumbnailUrl && !images.includes(data.thumbnailUrl)) {
      images.unshift(data.thumbnailUrl)
    }

    const { rows } = await query(
      `INSERT INTO garment_types
        (name, slug, cost_price,
         category_id, stock_quantity, unit, images, tags,
         is_featured, is_active, sku, barcode, low_stock_threshold, max_order_qty,
         ingredients, allergen_info, shelf_life, storage_instructions,
         certifications, nutrition_info, meta_title, meta_description,
         brand, brand_logo_url, net_quantity, highlights, attributes,
         vendor_name, vendor_address, vendor_fssai, return_policy,
         avg_rating, rating_count, is_authentic,
         product_family_id, option_label, option_sort_order, is_default_option,
         food_type, origin_tag, custom_badges, display_delivery_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
       RETURNING id, name, slug, NULL::numeric AS price, NULL::numeric AS sale_price, stock_quantity, unit,
                 (images->>0) AS thumbnail_url, category_id, is_featured, is_active, sku, created_at`,
      [
        data.name, data.slug, data.costPrice || null,
        data.categoryId, data.stock || 0, data.unit || 'piece',
        JSON.stringify(images), data.tags || [],
        data.isFeatured || false, data.isActive !== false,
        data.sku || null, data.barcode || null,
        data.lowStockThreshold || 10, data.maxOrderQty || null,
        data.ingredients || null, data.allergenInfo || null,
        data.shelfLife || null, data.storageInstructions || null,
        data.certifications || null,
        data.nutritionInfo ? data.nutritionInfo : null,
        data.metaTitle || null, data.metaDescription || null,
        data.brand || null, data.brandLogoUrl || null,
        data.netQuantity || null, JSON.stringify(data.highlights || {}),
        JSON.stringify(data.attributes || []),
        data.vendorName || null, data.vendorAddress || null,
        data.vendorFssai || null, data.returnPolicy || 'no_return',
        data.avgRating ?? 0, data.ratingCount ?? 0,
        data.isAuthentic !== false,
        data.productFamilyId || null, data.optionLabel || null,
        data.optionSortOrder ?? 0, data.isDefaultOption || false,
        data.foodType || 'NONE', data.originTag || 'NONE',
        JSON.stringify(data.customBadges || []),
        data.displayDeliveryMinutes || null,
      ]
    )

    if (data.variants && data.variants.length > 0) {
      await this.saveVariants(rows[0].id, data.variants)
    }

    return rows[0]
  }

  /**
   * Update product fields
   */
  async update(id, data) {
    const fieldMap = {
      name: 'name', costPrice: 'cost_price',
      categoryId: 'category_id', stock: 'stock_quantity',
      unit: 'unit',
      isFeatured: 'is_featured', isActive: 'is_active', slug: 'slug',
      sku: 'sku', barcode: 'barcode',
      lowStockThreshold: 'low_stock_threshold', maxOrderQty: 'max_order_qty',
      ingredients: 'ingredients', allergenInfo: 'allergen_info',
      shelfLife: 'shelf_life', storageInstructions: 'storage_instructions',
      metaTitle: 'meta_title', metaDescription: 'meta_description',
      brand: 'brand', brandLogoUrl: 'brand_logo_url',
      netQuantity: 'net_quantity', vendorName: 'vendor_name',
      vendorAddress: 'vendor_address', vendorFssai: 'vendor_fssai',
      returnPolicy: 'return_policy', isAuthentic: 'is_authentic',
      avgRating: 'avg_rating', ratingCount: 'rating_count',
      productFamilyId: 'product_family_id',
      optionLabel: 'option_label',
      optionSortOrder: 'option_sort_order',
      isDefaultOption: 'is_default_option',
      foodType: 'food_type',
      originTag: 'origin_tag',
      displayDeliveryMinutes: 'display_delivery_minutes',
    }

    const fields = []
    const params = []
    let idx = 1

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey] === '' ? null : data[jsKey])
      }
    }

    // Handle JSON/array fields separately
    if (data.images !== undefined) {
      fields.push(`images = $${idx++}`)
      params.push(JSON.stringify(data.images))
    } else if (data.thumbnailUrl !== undefined) {
      // garment_types has no thumbnail_url column (dropped by migration
      // 062) — a single thumbnailUrl from the admin form replaces the
      // images array wholesale (this table only ever shows one image).
      fields.push(`images = $${idx++}`)
      params.push(JSON.stringify(data.thumbnailUrl ? [data.thumbnailUrl] : []))
    }
    if (data.tags !== undefined) {
      fields.push(`tags = $${idx++}`)
      params.push(data.tags)
    }
    if (data.highlights !== undefined) {
      fields.push(`highlights = $${idx++}`)
      params.push(JSON.stringify(data.highlights))
    }
    if (data.attributes !== undefined) {
      fields.push(`attributes = $${idx++}`)
      params.push(JSON.stringify(data.attributes))
    }
    if (data.certifications !== undefined) {
      fields.push(`certifications = $${idx++}`)
      params.push(data.certifications)
    }
    if (data.customBadges !== undefined) {
      fields.push(`custom_badges = $${idx++}`)
      params.push(JSON.stringify(data.customBadges))
    }
    if (data.variants !== undefined) {
      await this.saveVariants(id, data.variants)
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE garment_types SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, NULL::numeric AS price, NULL::numeric AS sale_price, stock_quantity, unit,
                 (images->>0) AS thumbnail_url, category_id, is_featured, is_active, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Helper to save variants (deletes existing and inserts new)
   */
  async saveVariants(productId, variants) {
    if (!variants) return

    // Clear old variants
    await query(`DELETE FROM product_variants WHERE garment_rate_id = $1`, [productId])

    if (variants.length === 0) return

    // Insert new variants
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]
      await query(
        `INSERT INTO product_variants
          (garment_rate_id, name, sku, price, sale_price, stock, display_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          productId,
          v.name || ("Variant " + (i + 1)),
          v.sku || null,
          v.price || 0,
          v.salePrice || null,
          v.stockQuantity ?? v.stock ?? 0,
          i,
          v.isActive !== false
        ]
      )
    }
  }

  /**
   * Update stock quantity only
   */
  async updateStock(id, stock) {
    const { rows } = await query(
      `UPDATE garment_types SET stock_quantity = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, stock_quantity`,
      [stock, id]
    )
    return rows[0]
  }

  /**
   * Hard-delete product
   */
  async delete(id) {
    await query(
      `DELETE FROM garment_types WHERE id = $1`,
      [id]
    )
  }

  /**
   * Find garment_rates with active price drops (sale_price < price)
   * Used in cart "Price Drop Alert" section
   *
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   */
  async getPriceDrops(limit = 10, allocatedShopIds = null) {
    const params = []
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    params.push(limit)
    const limitIdx = visibility.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, NULL::text AS thumbnail_url, NULL::numeric AS price, NULL::numeric AS sale_price, p.unit, p.stock_quantity,
              0 AS discount
       FROM garment_types p
       WHERE p.is_active = true
         ${visibility.sql}
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Find last-minute / cafe / snack garment_rates
   * Used in cart "Last-Minute Cravings" section
   *
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   */
  async getLastMinute(limit = 10, allocatedShopIds = null) {
    const params = []
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    params.push(limit)
    const limitIdx = visibility.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, NULL::text AS thumbnail_url, NULL::numeric AS price, NULL::numeric AS sale_price, p.unit
       FROM garment_types p
       JOIN service_categories c ON p.category_id = c.id
       WHERE p.is_active = true
         ${visibility.sql}
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  async findPriceDrops(limit = 10, allocatedShopIds = null) {
    return this.getPriceDrops(limit, allocatedShopIds)
  }

  async findLastMinute(limit = 10, allocatedShopIds = null) {
    return this.getLastMinute(limit, allocatedShopIds)
  }
}
