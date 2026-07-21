import { query, getClient } from '../../../config/database.js'

export class AdminProductsRepository {
  async getAnalytics({ offset, limit, sortBy = 'revenue' }) {
    const orderCol = sortBy === 'views' ? 'views' : sortBy === 'sold' ? 'units_sold' : 'revenue'
    const { rows } = await query(
      `SELECT p.id, p.name, NULL::text AS thumbnail_url, NULL::numeric AS price, p.stock_quantity, p.is_active,
              COALESCE(oi_stats.units_sold, 0)::int AS units_sold,
              COALESCE(oi_stats.revenue, 0) AS revenue,
              COALESCE(pv_stats.views, 0)::int AS views,
              CASE WHEN COALESCE(pv_stats.views, 0) > 0
                THEN ROUND(COALESCE(oi_stats.units_sold, 0)::numeric / pv_stats.views * 100, 2)
                ELSE 0 END AS conversion_rate,
              c.name AS category
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN (
         SELECT oi.garment_type_id, SUM(oi.quantity)::int AS units_sold, SUM(oi.total) AS revenue
         FROM order_lines oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'DELIVERED'
         GROUP BY oi.garment_type_id
       ) oi_stats ON oi_stats.garment_type_id = p.id
       LEFT JOIN (
         SELECT garment_rate_id, COUNT(*)::int AS views FROM product_views GROUP BY garment_rate_id
       ) pv_stats ON pv_stats.garment_rate_id = p.id
       ORDER BY ${orderCol} DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    const countRes = await query('SELECT COUNT(*)::int AS total FROM garment_types')
    return { garment_rates: rows.map(r => ({ ...r, revenue: parseFloat(r.revenue) })), total: countRes.rows[0].total }
  }

  async getDeadStock(days = 30) {
    const { rows } = await query(
      `SELECT p.id, p.name, NULL::text AS thumbnail_url, p.stock_quantity, NULL::numeric AS price, p.created_at,
              c.name AS category
       FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       LEFT JOIN (
         SELECT DISTINCT oi.garment_type_id
         FROM order_lines oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= NOW() - make_interval(days => $1)
       ) recent ON recent.garment_type_id = p.id
       WHERE p.is_active = true AND recent.garment_type_id IS NULL
       ORDER BY p.stock_quantity DESC`,
      [days]
    )
    return rows
  }

  async getLowMargin(threshold = 15) {
    const { rows } = await query(
      `SELECT id, name, NULL::text AS thumbnail_url, NULL::numeric AS price, cost_price, stock_quantity,
              0 AS margin_pct
       FROM garment_types
       WHERE is_active = true AND cost_price IS NOT NULL AND cost_price > 0
       ORDER BY margin_pct ASC`
    )
    return rows.map(r => ({ ...r, margin_pct: parseFloat(r.margin_pct) }))
  }

  async getAllForExport() {
    const { rows } = await query(
      `SELECT p.id, p.name, p.sku, NULL::numeric AS price, NULL::numeric AS sale_price, p.cost_price, p.stock_quantity,
              p.unit, p.is_active, p.total_sold, c.name AS category, p.created_at
       FROM garment_types p LEFT JOIN service_categories c ON c.id = p.category_id
       ORDER BY p.name`
    )
    return rows
  }

  async bulkUpdate(updates) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const results = []
      for (const u of updates) {
        const sets = []
        const params = []
        let idx = 1
        if (u.category_id !== undefined) { sets.push(`category_id = $${idx++}`); params.push(u.category_id) }
        if (u.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(u.is_active) }
        if (sets.length === 0) continue

        sets.push(`updated_at = NOW()`)
        params.push(u.id)
        const { rows } = await client.query(
          `UPDATE garment_types SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name`,
          params
        )
        if (rows[0]) results.push(rows[0])
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async duplicate(productId) {
    const { rows: [p] } = await query('SELECT * FROM garment_types WHERE id = $1', [productId])
    if (!p) return null

    const newSlug = p.slug + '-copy-' + Date.now().toString(36)
    const { rows: [newProduct] } = await query(
      `INSERT INTO garment_types (name, slug, cost_price, category_id,
         stock_quantity, unit, images, tags, is_active, is_featured, sku, low_stock_threshold)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, false, false, $8, $9)
       RETURNING *`,
      [
        p.name + ' (Copy)', newSlug, p.cost_price,
        p.category_id, p.unit, JSON.stringify(p.images || []),
        p.tags, p.sku ? p.sku + '-COPY' : null, p.low_stock_threshold,
      ]
    )
    return newProduct
  }

  async findBySku(sku) {
    const { rows } = await query(
      `SELECT p.*, c.name AS category FROM garment_types p
       LEFT JOIN service_categories c ON c.id = p.category_id
       WHERE p.sku = $1`,
      [sku]
    )
    return rows[0] || null
  }
}
