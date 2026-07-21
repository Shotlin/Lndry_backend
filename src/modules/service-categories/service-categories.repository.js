import { query } from '../../config/database.js'

/**
 * Categories repository — all SQL queries for service_categories
 */
export class CategoriesRepository {
  /**
   * Get all active service_categories ordered by sort_order
   */
  async findAll() {
    const { rows } = await query(
      `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.parent_id, c.sort_order, c.is_active, c.created_at,
              (SELECT COUNT(*)::int FROM garment_types p WHERE p.category_id = c.id AND p.is_active = true) AS product_count
       FROM service_categories c
       WHERE c.is_active = true
       ORDER BY c.sort_order ASC, c.name ASC`
    )
    return rows
  }

  /**
   * Find a single category by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, name, slug, description, image_url, parent_id, sort_order, is_active, created_at, updated_at
       FROM service_categories WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Find a category by slug
   */
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT id FROM service_categories WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }

  /**
   * Create a new category
   */
  async create({ name, slug, description, image_url, parent_id, sort_order, is_active }) {
    const { rows } = await query(
      `INSERT INTO service_categories (name, slug, description, image_url, parent_id, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, slug, description, image_url, parent_id, sort_order, is_active, created_at`,
      [name, slug, description || null, image_url || null, parent_id || null, sort_order || 0, is_active !== false]
    )
    return rows[0]
  }

  /**
   * Update a category — only provided fields
   */
  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const allowed = ['name', 'slug', 'description', 'image_url', 'parent_id', 'sort_order', 'is_active']
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE service_categories SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, description, image_url, parent_id, sort_order, is_active, created_at, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Soft-delete: deactivate a category
   */
  async delete(id) {
    await query(
      `UPDATE service_categories SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  /**
   * Get garment_types belonging to a category (paginated).
   *
   * Surfaces the same product-family / option fields as the garment_types
   * listing endpoint so the Flutter category grid can render "N options",
   * veg/origin markers, ratings and delivery time consistently
   * (product-options contract). `option_count` counts active siblings in
   * the same family (1 for standalone garment_types).
   *
   * @param {string} categoryId
   * @param {object} opts
   * @param {number} opts.limit
   * @param {number} opts.offset
   * @param {string} [opts.sort]
   * @param {boolean} [opts.inStock]
   * @param {boolean} [opts.groupOptions] - When true, returns one
   *   representative per product_family_id (prefer default option) so
   *   sibling options collapse into a single card.
   * @param {string[]|null} [opts.allocatedShopIds] - Customer shop scoping;
   *   when set, only garment_types available in at least one allocated shop are
   *   returned (mirrors ProductsRepository.buildCustomerVisibilitySnippet).
   */
  async findProducts(
    categoryId,
    { limit, offset, sort, inStock, groupOptions = false, allocatedShopIds = null }
  ) {
    const conditions = ['p.is_active = true', 'p.category_id = $1']
    const params = [categoryId]
    let paramIdx = 2

    if (inStock) {
      conditions.push('p.stock_quantity > 0')
    }

    // Customer shop-allocation visibility (additive — only when scoped).
    if (Array.isArray(allocatedShopIds)) {
      if (allocatedShopIds.length === 0) {
        conditions.push('FALSE')
      } else {
        params.push(allocatedShopIds)
        conditions.push(`EXISTS (
          SELECT 1
            FROM vendor_services sp
            JOIN vendors s ON s.id = sp.vendor_id
           WHERE sp.garment_rate_id = p.id
             AND sp.vendor_id = ANY($${paramIdx}::uuid[])
             AND sp.is_available = true
             AND sp.deleted_at IS NULL
             AND s.is_active = true
             AND s.deleted_at IS NULL
        )`)
        paramIdx++
      }
    }

    const sortMap = {
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
      newest: 'p.created_at DESC',
      popular: 'p.total_sold DESC',
    }
    const orderBy = sortMap[sort] || 'p.created_at DESC'
    const where = conditions.join(' AND ')

    const optionCountExpr = `COALESCE(
      (SELECT COUNT(*)::int FROM garment_types sib
       WHERE sib.product_family_id = p.product_family_id
         AND sib.product_family_id IS NOT NULL
         AND sib.is_active = true), 1)`

    const selectCols = `
      p.id, p.name, p.slug, p.price, p.sale_price, p.stock_quantity,
      p.unit, p.thumbnail_url, p.is_featured, p.total_sold,
      p.product_family_id, p.option_label, p.option_sort_order,
      p.is_default_option, p.food_type, p.origin_tag,
      p.custom_badges, p.display_delivery_minutes,
      p.avg_rating, p.rating_count, p.net_quantity,
      p.created_at,
      pf.name AS family_name,
      ${optionCountExpr} AS option_count`

    if (groupOptions) {
      const { rows } = await query(
        `WITH ranked AS (
          SELECT ${selectCols},
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(p.product_family_id, p.id)
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.price ASC
            ) AS rn
          FROM garment_types p
          LEFT JOIN product_families pf ON pf.id = p.product_family_id
          WHERE ${where}
        )
        SELECT id, name, slug, price, sale_price, stock_quantity,
               unit, thumbnail_url, is_featured, total_sold,
               product_family_id, option_label, option_sort_order,
               is_default_option, food_type, origin_tag,
               custom_badges, display_delivery_minutes,
               avg_rating, rating_count, net_quantity,
               created_at, family_name, option_count
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
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.price ASC
            ) AS rn
          FROM garment_types p
          WHERE ${where}
        )
        SELECT COUNT(*)::int AS total FROM ranked WHERE rn = 1`,
        params
      )

      return { data: rows, total: countRows[0]?.total || 0 }
    }

    const { rows } = await query(
      `SELECT ${selectCols}
       FROM garment_types p
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

    return { data: rows, total: countRows[0]?.total || 0 }
  }
}
