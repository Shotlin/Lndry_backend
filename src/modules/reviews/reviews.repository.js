import { query } from '../../config/database.js'

/**
 * Reviews repository — database access for reviews
 */
export class ReviewsRepository {
  async getVendorReviews(vendorId, { offset, limit }) {
    const [countResult, result, avgResult] = await Promise.all([
      query('SELECT COUNT(*) FROM reviews WHERE vendor_id = $1 AND deleted_at IS NULL', [vendorId]),
      query(
        `SELECT r.id, r.vendor_rating, r.rider_rating, r.comment, r.created_at,
                u.name as user_name
         FROM reviews r
         JOIN users u ON r.user_id = u.id
         WHERE r.vendor_id = $1 AND r.deleted_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [vendorId, limit, offset]
      ),
      query('SELECT AVG(vendor_rating) as avg_rating FROM reviews WHERE vendor_id = $1 AND deleted_at IS NULL', [vendorId]),
    ])

    const total = parseInt(countResult.rows[0].count)

    return {
      reviews: result.rows,
      averageRating: parseFloat(avgResult.rows[0].avg_rating) || 0,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getOrderById(orderId) {
    const { rows } = await query(
      'SELECT id, user_id, vendor_id, status FROM orders WHERE id = $1',
      [orderId]
    )
    return rows[0] || null
  }

  async getVendorReviewByOrder(userId, orderId) {
    const { rows } = await query(
      'SELECT id FROM reviews WHERE user_id = $1 AND order_id = $2 AND deleted_at IS NULL',
      [userId, orderId]
    )
    return rows[0] || null
  }

  async createVendorReview(userId, { orderId, vendorId, vendorRating, riderRating, comment }) {
    const { rows } = await query(
      `INSERT INTO reviews (user_id, order_id, vendor_id, vendor_rating, rider_rating, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, order_id, vendor_id, vendor_rating, rider_rating, comment, created_at`,
      [userId, orderId, vendorId, vendorRating, riderRating || null, comment || null]
    )
    return rows[0]
  }

  async getProductReviews(productId, { offset, limit }) {
    const [countResult, result, avgResult] = await Promise.all([
      query('SELECT COUNT(*) FROM reviews WHERE garment_rate_id = $1 AND deleted_at IS NULL', [productId]),
      query(
        `SELECT r.id, r.rating, r.comment, r.created_at,
                u.name as user_name
         FROM reviews r
         JOIN users u ON r.user_id = u.id
         WHERE r.garment_rate_id = $1 AND r.deleted_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [productId, limit, offset]
      ),
      query('SELECT AVG(rating) as avg_rating FROM reviews WHERE garment_rate_id = $1 AND deleted_at IS NULL', [productId]),
    ])

    const total = parseInt(countResult.rows[0].count)

    return {
      reviews: result.rows,
      averageRating: parseFloat(avgResult.rows[0].avg_rating) || 0,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async checkUserOrder(userId, orderId, productId) {
    const { rows } = await query(
      `SELECT 1 FROM orders o
       WHERE o.id = $1 AND o.user_id = $2
       AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(o.items) AS item
          WHERE item->>'productId' = $3
       )`,
      [orderId, userId, productId]
    )
    return rows.length > 0
  }

  async checkReviewEligibility(userId, productId) {
    const { rows } = await query(
      `SELECT o.id,
              EXISTS (
                SELECT 1
                FROM reviews r
                WHERE r.user_id = $1
                  AND r.order_id = o.id
                  AND r.garment_rate_id = $2
                  AND r.deleted_at IS NULL
              ) AS has_review
       FROM orders o
       WHERE o.user_id = $1
         AND o.status = 'DELIVERED'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(o.items) AS item
           WHERE item->>'productId' = $2::text
         )
       ORDER BY o.created_at DESC`,
      [userId, productId]
    )

    if (rows.length === 0) {
      return { eligible: false, orderId: null, alreadyReviewed: false }
    }

    const eligibleOrder = rows.find(row => !row.has_review)
    if (eligibleOrder) {
      return { eligible: true, orderId: eligibleOrder.id, alreadyReviewed: false }
    }

    return { eligible: false, orderId: null, alreadyReviewed: true }
  }

  async getReviewByOrder(userId, orderId, productId) {
    const { rows } = await query(
      'SELECT id FROM reviews WHERE user_id = $1 AND order_id = $2 AND garment_rate_id = $3 AND deleted_at IS NULL',
      [userId, orderId, productId]
    )
    return rows[0]
  }

  async createReview(userId, { productId, orderId, rating, comment }) {
    const { rows } = await query(
      `INSERT INTO reviews (user_id, garment_rate_id, order_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, garment_rate_id, order_id, rating, comment, created_at`,
      [userId, productId, orderId, rating, comment || null]
    )
    return rows[0]
  }

  async getReviewById(reviewId) {
    const { rows } = await query(
      'SELECT id, user_id, garment_rate_id, order_id, rating, vendor_rating, rider_rating, comment, created_at FROM reviews WHERE id = $1 AND deleted_at IS NULL',
      [reviewId]
    )
    return rows[0]
  }

  async updateReview(reviewId, { rating, comment, vendor_rating, rider_rating }) {
    const updates = []
    const params = []
    let idx = 1

    if (rating !== undefined) {
      updates.push(`rating = $${idx}`)
      params.push(rating)
      idx++
    }

    if (vendor_rating !== undefined) {
      updates.push(`vendor_rating = $${idx}`)
      params.push(vendor_rating)
      idx++
    }

    if (rider_rating !== undefined) {
      updates.push(`rider_rating = $${idx}`)
      params.push(rider_rating)
      idx++
    }

    if (comment !== undefined) {
      updates.push(`comment = $${idx}`)
      params.push(comment)
      idx++
    }

    params.push(reviewId)
    const { rows } = await query(
      `UPDATE reviews SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, garment_rate_id, order_id, rating, vendor_rating, rider_rating, comment, updated_at`,
      params
    )
    return rows[0]
  }

  async deleteReview(reviewId) {
    await query('UPDATE reviews SET deleted_at = NOW() WHERE id = $1', [reviewId])
  }

  async getUserReviews(userId, { offset, limit }) {
    const [countResult, result] = await Promise.all([
      query('SELECT COUNT(*) FROM reviews WHERE user_id = $1 AND deleted_at IS NULL', [userId]),
      query(
        `SELECT r.id, r.rating, r.vendor_rating, r.rider_rating, r.comment, r.created_at,
                p.name as product_name, p.images as product_images,
                v.name as vendor_name
         FROM reviews r
         LEFT JOIN garment_rates p ON r.garment_rate_id = p.id
         LEFT JOIN vendors v ON r.vendor_id = v.id
         WHERE r.user_id = $1 AND r.deleted_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
    ])

    const total = parseInt(countResult.rows[0].count)

    return {
      reviews: result.rows.map(r => ({
        ...r,
        product_image: r.product_images?.[0] || null,
      })),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }
}

