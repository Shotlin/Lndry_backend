import { createHash } from 'crypto'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { success, error } from '../../utils/apiResponse.js'
import { logger } from '../../config/logger.js'
import {
  ACTIVE_THEME_CACHE_KEY,
  getSectionPublicCacheKey,
  getTabHomeCacheKey,
  getTabManifestCacheKey,
} from './theme-cache.js'
import { STORE_KEYS } from '../theme-tabs/theme-tabs.shared.js'

const CACHE_TTL = 300

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5B: Safe mobile home payload caps.
//
// These constants define the maximum product count returned by each section
// type in the public mobile home endpoint. Dashboard admins can still
// configure higher limits via merch_config, but the mobile API always clamps
// to these values regardless.
//
// Rationale: Flutter home screen renders at most 12 garment_rates per carousel
// and 8 per category rail. Sending more is wasted JSON decode/network work.
// The caps are intentionally generous (not minimal) to ensure sections look
// full on screen.
// ─────────────────────────────────────────────────────────────────────────────
const HOME_CAPS = {
  featured:         12, // horizontal carousel — 12 fills 3 visible + scrollable
  deals:            12, // same
  trending:         12, // same
  seasonal:          8, // mosaic hero+4 pattern
  categoryRail:      8, // 3-column grid shows 6; 8 gives one extra row
  defaultRailItems:  8, // getDefaultCategorySections per-rail limit
  defaultRailCount:  4, // max category rails in fallback
}

// Section-level product count cap applied to every section type from the
// manifest (productCarousel, categoryProductGrid, archedShowcase, etc.).
// The dashboard ProductConfigEditor already clamps its slider to 20 (phase 5D),
// but we enforce a server-side cap here so old/mis-configured records are safe.
const HOME_MANIFEST_SECTION_CAP = 12

export class PublicThemeController {
  async getActiveTheme(request, reply) {
    const cached = await redis.get(ACTIVE_THEME_CACHE_KEY)
    if (cached) {
      return success(JSON.parse(cached), 'Active theme')
    }

    const { rows } = await query(
      'SELECT theme_data FROM app_themes WHERE is_active = true LIMIT 1'
    )

    const themeData = rows[0]?.theme_data ?? null

    if (themeData) {
      await redis.set(ACTIVE_THEME_CACHE_KEY, JSON.stringify(themeData), 'EX', CACHE_TTL)
    }

    return success(themeData, 'Active theme')
  }

  async getTabThemes(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const clientETag = request.headers['if-none-match']
    const cacheKey = getTabManifestCacheKey(storeKey)

    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      const etag = parsed._etag

      if (clientETag && clientETag === etag) {
        reply.code(304)
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      return success(parsed.data, 'Tab themes')
    }

    const rows = await getTabManifestRows(storeKey)
    const responseData = buildTabManifestResponse(storeKey, rows)
    const etag = createHash('md5').update(JSON.stringify(responseData)).digest('hex')

    await redis.set(
      cacheKey,
      JSON.stringify({ _etag: etag, data: responseData }),
      'EX',
      CACHE_TTL
    )

    if (clientETag && clientETag === etag) {
      reply.code(304)
      return
    }

    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60')
    return success(responseData, 'Tab themes')
  }

  async getTabHomeContent(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const tabKey = `${request.params.key || ''}`.trim()

    if (!tabKey) {
      reply.code(400)
      return error('Tab key is required', 'BAD_REQUEST')
    }

    const cacheKey = getTabHomeCacheKey(storeKey, tabKey)
    const cached = await redis.get(cacheKey)
    if (cached) {
      return success(JSON.parse(cached), 'Tab home content')
    }

    const tab = await getTabDefinition(storeKey, tabKey)
    if (!tab) {
      reply.code(404)
      return error('Tab not found', 'NOT_FOUND')
    }

    const merchConfig = tab.merch_config || {}

    // PHASE 5B: Each resolveSectionProducts call gets the dashboard-configured
    // limit clamped to HOME_CAPS.* — regardless of what the dashboard stored.
    const featuredProducts = await resolveSectionProducts(
      merchConfig.featured,
      () => getFeaturedProducts(HOME_CAPS.featured),
      HOME_CAPS.featured
    )
    const dealProducts = await resolveSectionProducts(
      merchConfig.deals,
      () => getDealProducts(HOME_CAPS.deals),
      HOME_CAPS.deals
    )
    const trendingProducts = await resolveSectionProducts(
      merchConfig.trending,
      () => getTrendingProducts(HOME_CAPS.trending),
      HOME_CAPS.trending
    )
    const seasonalProducts = await resolveSectionProducts(
      merchConfig.seasonal_mosaic,
      async () => mergeUniqueProducts([
        await getDealProducts(HOME_CAPS.seasonal),
        await getFeaturedProducts(HOME_CAPS.seasonal),
        await getTrendingProducts(HOME_CAPS.seasonal),
      ]).slice(0, HOME_CAPS.seasonal),
      HOME_CAPS.seasonal
    )
    const categorySections = await resolveCategorySections(
      merchConfig.category_rails,
      async () => getDefaultCategorySections(
        HOME_CAPS.defaultRailCount,
        HOME_CAPS.defaultRailItems
      ),
      HOME_CAPS.categoryRail
    )

    const responseData = {
      store_key: storeKey,
      tab_key: tab.key,
      seasonal_products: seasonalProducts,
      featured_products: featuredProducts,
      deal_products: dealProducts,
      trending_products: trendingProducts,
      category_sections: categorySections,
      // PHASE 5E: Future-safe pagination hints.
      // Clients can check has_more to know a "Load more" path is available.
      // The actual load-more endpoint (GET /api/v1/home/sections/:id/items?cursor=)
      // is documented but not yet built — this flag prepares the schema so
      // Flutter can conditionally show load-more controls without a breaking
      // API change later.
      _meta: {
        effective_limits: {
          featured: HOME_CAPS.featured,
          deals: HOME_CAPS.deals,
          trending: HOME_CAPS.trending,
          seasonal: HOME_CAPS.seasonal,
          category_rail: HOME_CAPS.categoryRail,
        },
        has_more: {
          featured: featuredProducts.length >= HOME_CAPS.featured,
          deals: dealProducts.length >= HOME_CAPS.deals,
          trending: trendingProducts.length >= HOME_CAPS.trending,
        },
      },
    }

    // PHASE 5F: Lightweight payload logging for QA/staging.
    // Only logs at debug level — production log level (info/warn) is unaffected.
    _logHomePayload(storeKey, tabKey, responseData)

    await redis.set(cacheKey, JSON.stringify(responseData), 'EX', CACHE_TTL)
    return success(responseData, 'Tab home content')
  }

  async recordAnalytics(request, reply) {
    const events = request.body?.events
    if (!Array.isArray(events) || events.length === 0) {
      return success(null, 'No events')
    }

    const batch = events.slice(0, 50)
    const values = []
    const params = []
    let idx = 1

    for (const event of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push(
        event.theme_id || null,
        event.tab_key || 'unknown',
        event.event_type || 'impression',
        event.user_id || null,
        event.session_id || null,
        normalizeStoreKey(event.store_key),
        event.section_key || null
      )
    }

    await query(
      `INSERT INTO theme_analytics (
         theme_id,
         tab_key,
         event_type,
         user_id,
         session_id,
         store_key,
         section_key
       )
       VALUES ${values.join(', ')}`,
      params
    )

    return success(null, 'Analytics recorded')
  }

  async getSectionManifest(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const tabKey = `${request.params.tabKey || ''}`.trim()

    if (!tabKey) {
      reply.code(400)
      return error('Tab key is required', 'BAD_REQUEST')
    }

    const clientETag = request.headers['if-none-match']
    const cacheKey = getSectionPublicCacheKey(storeKey, tabKey)

    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      const etag = parsed._etag

      if (clientETag && clientETag === etag) {
        reply.code(304)
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      return success(parsed.data, 'Section manifest')
    }

    const tab = await getTabDefinition(storeKey, tabKey)
    if (!tab) {
      reply.code(404)
      return error('Tab not found', 'NOT_FOUND')
    }

    const { rows } = await query(
      `SELECT
         id,
         section_type AS type,
         sort_order AS "order",
         visible,
         config,
         merch_binding
       FROM section_manifests
       WHERE tab_id = $1
         AND visible = true
       ORDER BY sort_order ASC`,
      [tab.id]
    )

    // Resolve garment_rates for sections that have product_ids or category_ids in merch_binding.
    // Without this step the mobile receives only IDs and renders nothing.
    const resolvedSections = await Promise.all(
      rows.map(async (section) => {
        const binding = section.merch_binding || {}
        const productIds = Array.isArray(binding.product_ids) ? binding.product_ids : []
        const categoryIds = Array.isArray(binding.category_ids) ? binding.category_ids : []
        const limit = normalizeLimit(binding.limit, HOME_MANIFEST_SECTION_CAP, HOME_MANIFEST_SECTION_CAP)

        // No IDs configured — section uses its own rendering logic (banners, spacers, etc.)
        if (productIds.length === 0 && categoryIds.length === 0) {
          return section
        }

        // Fetch manually pinned garment_rates first, preserving dashboard order
        const manualProducts = productIds.length > 0
          ? await getProductsByIds(productIds)
          : []
        const seenIds = manualProducts.map((p) => p.id)

        // Fill remaining slots from category if needed
        let garment_rates = manualProducts
        if (garment_rates.length < limit && categoryIds.length > 0) {
          const fillProducts = await getProductsByCategoryIds(
            categoryIds,
            limit - garment_rates.length,
            seenIds
          )
          garment_rates = [...manualProducts, ...fillProducts]
        }

        return {
          ...section,
          garment_rates: garment_rates.slice(0, limit),
        }
      })
    )

    const responseData = {
      tab_key: tabKey,
      store_key: storeKey,
      sections: resolvedSections,
    }
    const etag = createHash('md5').update(JSON.stringify(responseData)).digest('hex')

    await redis.set(
      cacheKey,
      JSON.stringify({ _etag: etag, data: responseData }),
      'EX',
      CACHE_TTL
    )

    if (clientETag && clientETag === etag) {
      reply.code(304)
      return
    }

    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60')
    return success(responseData, 'Section manifest')
  }
}

function normalizeStoreKey(storeKey) {
  const normalized = `${storeKey || 'zepto'}`.trim()
  return STORE_KEYS.includes(normalized) ? normalized : 'zepto'
}

async function getTabManifestRows(storeKey) {
  const { rows } = await query(
    `SELECT
       tab.id AS tab_id,
       tab.store_key,
       tab.key AS tab_key,
       tab.label AS tab_label,
       tab.image_url AS tab_icon_url,
       tab.text_color AS tab_text_color,
       tab.sort_order AS tab_order,
       theme_a.id AS theme_id,
       theme_a.ab_variant,
       theme_a.theme_data,
       theme_b.theme_data AS variant_b_theme_data,
       theme_b.ab_split_percent AS variant_b_split
     FROM theme_tabs tab
     LEFT JOIN LATERAL (
       SELECT id, ab_variant, theme_data
       FROM app_themes
       WHERE tab_id = tab.id
         AND status = 'active'
         AND ab_variant = 'A'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1
     ) theme_a ON true
     LEFT JOIN LATERAL (
       SELECT theme_data, ab_split_percent
       FROM app_themes
       WHERE tab_id = tab.id
         AND status = 'active'
         AND ab_variant = 'B'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1
     ) theme_b ON true
     WHERE tab.store_key = $1
       AND tab.status = 'active'
     ORDER BY tab.sort_order ASC, tab.label ASC`,
    [storeKey]
  )

  return rows
}

function buildTabManifestResponse(storeKey, rows) {
  const fallbackTheme =
    rows.find((row) => row.tab_key === 'all' && row.theme_data)?.theme_data ?? null

  const tabs = rows.map((row) => {
    const themeData = mergeThemeData(fallbackTheme, row.theme_data)
    const variantBThemeData = mergeThemeData(fallbackTheme, row.variant_b_theme_data)

    return {
      tab_id: row.tab_id,
      store_key: storeKey,
      theme_id: row.theme_id,
      tab_key: row.tab_key,
      tab_label: row.tab_label,
      tab_icon_url: row.tab_icon_url,
      tab_text_color: row.tab_text_color,
      tab_order: row.tab_order,
      variant: row.ab_variant || 'A',
      theme_data: themeData,
      ...(variantBThemeData
        ? {
            ab_test: {
              variant_b_data: variantBThemeData,
              split_percent: row.variant_b_split || 0,
            },
          }
        : {}),
    }
  })

  return {
    store_key: storeKey,
    tabs,
  }
}

function mergeThemeData(baseValue, overrideValue) {
  if (overrideValue == null) {
    return baseValue ?? null
  }

  if (Array.isArray(overrideValue)) {
    return overrideValue
  }

  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const merged = { ...baseValue }
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = mergeThemeData(baseValue[key], value)
    }
    return merged
  }

  return overrideValue
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function getTabDefinition(storeKey, tabKey) {
  const { rows: [tab] } = await query(
    `SELECT id, store_key, key, merch_config
     FROM theme_tabs
     WHERE store_key = $1
       AND key = $2
       AND status = 'active'
     LIMIT 1`,
    [storeKey, tabKey]
  )
  return tab || null
}

async function resolveSectionProducts(config, fallbackResolver, cap) {
  const productIds = Array.isArray(config?.product_ids) ? config.product_ids : []
  const categoryIds = Array.isArray(config?.category_ids) ? config.category_ids : []
  // PHASE 5B: normalizeLimit honours dashboard config but clamps to cap.
  const limit = normalizeLimit(config?.limit, cap ?? HOME_CAPS.featured, cap)

  if (productIds.length === 0 && categoryIds.length === 0) {
    return (await fallbackResolver()).slice(0, limit)
  }

  const manualProducts = await getProductsByIds(productIds)
  const seenIds = new Set(manualProducts.map((product) => product.id))

  if (manualProducts.length >= limit || categoryIds.length === 0) {
    return manualProducts.slice(0, limit)
  }

  const fillProducts = await getProductsByCategoryIds(
    categoryIds,
    limit - manualProducts.length,
    [...seenIds]
  )

  return [...manualProducts, ...fillProducts].slice(0, limit)
}

async function resolveCategorySections(rails, fallbackResolver, railCap) {
  if (!Array.isArray(rails) || rails.length === 0) {
    return fallbackResolver()
  }

  const sections = []

  for (const rail of rails) {
    if (!rail?.category_id) continue

    // PHASE 5B: each rail limit clamped to railCap.
    const limit = normalizeLimit(rail.limit, HOME_CAPS.categoryRail, railCap)
    const manualProducts = await getProductsByIds(
      Array.isArray(rail.product_ids) ? rail.product_ids : []
    )
    const seenIds = manualProducts.map((product) => product.id)
    const fillProducts =
      manualProducts.length < limit
        ? await getProductsByCategoryIds(
            [rail.category_id],
            limit - manualProducts.length,
            seenIds
          )
        : []

    const garment_rates = [...manualProducts, ...fillProducts].slice(0, limit)
    if (garment_rates.length === 0) continue

    const title = rail.title || (await getCategoryName(rail.category_id))
    sections.push({
      category_id: rail.category_id,
      title,
      garment_rates,
    })
  }

  return sections.length > 0 ? sections : fallbackResolver()
}

async function getProductsByIds(productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return []
  }

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       p.price,
       p.sale_price,
       p.stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM garment_rates ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM garment_rates p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     WHERE p.is_active = true
       AND p.stock_quantity > 0
       AND p.id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], p.id)`,
    [productIds]
  )

  return rows
}

async function getProductsByCategoryIds(categoryIds, limit, excludeIds = []) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0 || limit <= 0) {
    return []
  }

  const params = [categoryIds, limit]
  let where = `
    p.is_active = true
    AND p.stock_quantity > 0
    AND p.category_id = ANY($1::uuid[])
  `

  if (excludeIds.length > 0) {
    params.push(excludeIds)
    where += ` AND NOT (p.id = ANY($3::uuid[]))`
  }

  const limitPlaceholder = excludeIds.length > 0 ? '$2' : '$2'

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       p.price,
       p.sale_price,
       p.stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM garment_rates ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM garment_rates p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     WHERE ${where}
     ORDER BY p.is_featured DESC, p.total_sold DESC, p.created_at DESC
     LIMIT ${limitPlaceholder}`,
    params
  )

  return rows
}

async function getFeaturedProducts(limit) {
  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       p.price,
       p.sale_price,
       p.stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM garment_rates ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM garment_rates p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     WHERE p.is_active = true
       AND p.stock_quantity > 0
       AND p.is_featured = true
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $1`,
    [limit]
  )

  return rows
}

async function getDealProducts(limit) {
  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       p.price,
       p.sale_price,
       p.stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM garment_rates ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM garment_rates p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     WHERE p.is_active = true
       AND p.stock_quantity > 0
       AND p.sale_price IS NOT NULL
       AND p.sale_price < p.price
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $1`,
    [limit]
  )

  return rows
}

async function getTrendingProducts(limit) {
  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       p.price,
       p.sale_price,
       p.stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       COALESCE(
         (SELECT COUNT(*)::int FROM garment_rates ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM garment_rates p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     WHERE p.is_active = true
       AND p.stock_quantity > 0
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $1`,
    [limit]
  )

  return rows
}

async function getDefaultCategorySections(limitSections, itemsPerSection) {
  const { rows: categories } = await query(
    `SELECT
       c.id,
       c.name
     FROM categories c
     WHERE c.is_active = true
       AND c.parent_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM garment_rates p
         WHERE p.category_id = c.id
           AND p.is_active = true
           AND p.stock_quantity > 0
       )
     ORDER BY c.sort_order ASC, c.name ASC
     LIMIT $1`,
    [limitSections ?? HOME_CAPS.defaultRailCount]
  )

  const perRail = itemsPerSection ?? HOME_CAPS.defaultRailItems
  const sections = []
  for (const category of categories) {
    // PHASE 5B: use configurable per-rail cap.
    const garment_rates = await getProductsByCategoryIds([category.id], perRail, [])
    if (garment_rates.length === 0) continue
    sections.push({
      category_id: category.id,
      title: category.name,
      garment_rates,
    })
  }

  return sections
}

async function getCategoryName(categoryId) {
  const { rows: [category] } = await query(
    'SELECT name FROM categories WHERE id = $1 LIMIT 1',
    [categoryId]
  )
  return category?.name || 'Category'
}

function mergeUniqueProducts(groups) {
  const seen = new Set()
  const merged = []

  for (const group of groups) {
    for (const product of group) {
      if (!seen.has(product.id)) {
        seen.add(product.id)
        merged.push(product)
      }
    }
  }

  return merged
}

/**
 * PHASE 5B: normalizeLimit — parse dashboard limit, apply safe mobile cap.
 *
 * @param {any}    value    - raw dashboard config value
 * @param {number} fallback - default when value is absent/invalid
 * @param {number} [cap]    - optional hard ceiling (overrides max=50 for mobile home)
 */
function normalizeLimit(value, fallback, cap) {
  const parsed = Number(value)
  const resolved = (!Number.isFinite(parsed) || parsed <= 0) ? fallback : Math.trunc(parsed)
  // If a per-context cap is provided, honour it; otherwise keep the legacy 50 ceiling
  // so non-home endpoints (admin, full category pages) are unchanged.
  const ceiling = (typeof cap === 'number' && cap > 0) ? cap : 50
  return Math.min(Math.max(resolved, 1), ceiling)
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5F: Lightweight home payload debug logging.
// Only fires at Pino 'debug' level — production deployments set LOG_LEVEL=info
// so this is zero-cost in prod. Staging/QA can set LOG_LEVEL=debug to see it.
// ─────────────────────────────────────────────────────────────────────────────
function _logHomePayload(storeKey, tabKey, data) {
  if (!logger.isLevelEnabled?.('debug') && logger.level !== 'debug') return

  const totalProducts =
    (data.featured_products?.length ?? 0) +
    (data.deal_products?.length ?? 0) +
    (data.trending_products?.length ?? 0) +
    (data.seasonal_products?.length ?? 0) +
    (data.category_sections ?? []).reduce((sum, s) => sum + (s.garment_rates?.length ?? 0), 0)

  const approxBytes = JSON.stringify(data).length

  logger.debug(
    {
      storeKey,
      tabKey,
      counts: {
        featured: data.featured_products?.length ?? 0,
        deals: data.deal_products?.length ?? 0,
        trending: data.trending_products?.length ?? 0,
        seasonal: data.seasonal_products?.length ?? 0,
        categorySections: data.category_sections?.length ?? 0,
        categoryRailProducts: (data.category_sections ?? []).map(s => s.garment_rates?.length ?? 0),
      },
      totalProducts,
      approxBytes,
      action: 'tab_home_content.payload',
    },
    `[home-payload] ${tabKey}@${storeKey}: ${totalProducts} garment_rates, ~${Math.round(approxBytes / 1024)}KB`
  )
}
