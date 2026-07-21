import { query } from '../../config/database.js'

/**
 * Coupons repository — all SQL queries for coupons.
 *
 * Multi-vendor extensions (migration 044, design §3.2.6, R26.1):
 *   coupon_type, absorber, vendor_id, applicable_shop_ids,
 *   applicable_category_ids, applicable_product_ids, usage_limit_total,
 *   usage_limit_per_user, created_by
 *
 * The legacy single-vendor columns (`usage_limit`, `used_count`,
 * `per_user_limit`) are intentionally retained so the existing
 * single-vendor checkout flow keeps working until the service layer is
 * migrated to the multi-vendor application algorithm in task 9.2.
 */
const COUPON_COLUMNS = `
  id, code, description,
  discount_type, discount_value,
  min_order_amount, max_discount,
  usage_limit, used_count, per_user_limit,
  valid_from, valid_until,
  is_active,
  coupon_type, absorber, vendor_id,
  applicable_shop_ids, applicable_category_ids, applicable_product_ids,
  usage_limit_total, usage_limit_per_user,
  created_by,
  created_at, updated_at
`

export class CouponsRepository {
  /**
   * Find active coupon by code (case-insensitive)
   */
  async findByCode(code) {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons
       WHERE UPPER(code) = UPPER($1)`,
      [code]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find coupon by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Get user's usage count for a coupon
   */
  async getUserUsageCount(couponId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM coupon_usages
       WHERE coupon_id = $1 AND user_id = $2`,
      [couponId, userId]
    )
    return rows[0].count
  }

  /**
   * Get total usage count for a coupon (across all users).
   * Used by task 9.4 validation for usage_limit_total.
   */
  async getTotalUsageCount(couponId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM coupon_usages
       WHERE coupon_id = $1`,
      [couponId]
    )
    return rows[0].count
  }

  /**
   * Record coupon usage
   */
  async recordUsage(couponId, userId, orderId) {
    await query(
      `INSERT INTO coupon_usages (coupon_id, user_id, order_id) VALUES ($1, $2, $3)`,
      [couponId, userId, orderId]
    )
    await query(
      `UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1`,
      [couponId]
    )
  }

  /**
   * Get all active/valid coupons
   */
  async findAvailable() {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons
       WHERE is_active = true
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
         AND (usage_limit IS NULL OR used_count < usage_limit)
       ORDER BY created_at DESC`
    )
    return rows.map(this._format)
  }

  /**
   * List all coupons — admin (paginated)
   */
  async findAll({ limit, offset }) {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS total FROM coupons`)
    return { data: rows.map(this._format), total: countRows[0].total }
  }

  /**
   * Create a coupon.
   *
   * Defaults:
   *   - couponType  → 'PLATFORM_COUPON'
   *   - absorber    → 'PLATFORM' for PLATFORM_COUPON, 'SHOP' for
   *                   SHOP_COUPON, 'PLATFORM' otherwise.
   *
   * Cross-field consistency (e.g. SHOP_COUPON → vendor_id required, or
   * PLATFORM_COUPON → absorber must be 'PLATFORM') is enforced by both
   * the DB CHECK constraints (chk_coupons_shop_required,
   * chk_coupons_platform_absorber from migration 044) and the service
   * layer in task 9.2.
   */
  async create(data) {
    const couponType = data.couponType || 'PLATFORM_COUPON'
    const absorber =
      data.absorber || (couponType === 'SHOP_COUPON' ? 'SHOP' : 'PLATFORM')

    const { rows } = await query(
      `INSERT INTO coupons (
         code, description,
         discount_type, discount_value,
         min_order_amount, max_discount,
         usage_limit, per_user_limit,
         valid_from, valid_until,
         coupon_type, absorber, vendor_id,
         applicable_shop_ids, applicable_category_ids, applicable_product_ids,
         usage_limit_total, usage_limit_per_user,
         created_by
       )
       VALUES (
         UPPER($1), $2,
         $3, $4,
         $5, $6,
         $7, $8,
         $9, $10,
         $11, $12, $13,
         $14, $15, $16,
         $17, $18,
         $19
       )
       RETURNING ${COUPON_COLUMNS}`,
      [
        data.code,
        data.description ?? null,
        data.discountType,
        data.discountValue,
        data.minOrderAmount ?? 0,
        data.maxDiscount ?? null,
        data.usageLimit ?? null,
        data.perUserLimit ?? 1,
        data.validFrom ?? null,
        data.validUntil ?? null,
        couponType,
        absorber,
        data.shopId ?? null,
        data.applicableShopIds ?? null,
        data.applicableCategoryIds ?? null,
        data.applicableProductIds ?? null,
        data.usageLimitTotal ?? null,
        data.usageLimitPerUser ?? 1,
        data.createdBy ?? null,
      ]
    )
    return this._format(rows[0])
  }

  /**
   * Update a coupon
   */
  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = {
      code:                  'code',
      description:           'description',
      discountType:          'discount_type',
      discountValue:         'discount_value',
      minOrderAmount:        'min_order_amount',
      maxDiscount:           'max_discount',
      usageLimit:            'usage_limit',
      perUserLimit:          'per_user_limit',
      validFrom:             'valid_from',
      validUntil:            'valid_until',
      isActive:              'is_active',
      couponType:            'coupon_type',
      absorber:              'absorber',
      shopId:                'vendor_id',
      applicableShopIds:     'applicable_shop_ids',
      applicableCategoryIds: 'applicable_category_ids',
      applicableProductIds:  'applicable_product_ids',
      usageLimitTotal:       'usage_limit_total',
      usageLimitPerUser:     'usage_limit_per_user',
      createdBy:             'created_by',
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        const val = jsKey === 'code' ? String(data[jsKey]).toUpperCase() : data[jsKey]
        fields.push(`${dbKey} = $${idx++}`)
        params.push(val)
      }
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE coupons SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING ${COUPON_COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Delete a coupon
   */
  async delete(id) {
    const result = await query(`DELETE FROM coupons WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id:                    row.id,
      code:                  row.code,
      description:           row.description,
      discountType:          row.discount_type,
      discountValue:         parseFloat(row.discount_value),
      minOrderAmount:        parseFloat(row.min_order_amount),
      maxDiscount:           row.max_discount != null ? parseFloat(row.max_discount) : null,
      usageLimit:            row.usage_limit,
      usedCount:             row.used_count,
      perUserLimit:          row.per_user_limit,
      validFrom:             row.valid_from,
      validUntil:            row.valid_until,
      isActive:              row.is_active,
      couponType:            row.coupon_type,
      absorber:              row.absorber,
      shopId:                row.vendor_id,
      applicableShopIds:     row.applicable_shop_ids,
      applicableCategoryIds: row.applicable_category_ids,
      applicableProductIds:  row.applicable_product_ids,
      usageLimitTotal:       row.usage_limit_total,
      usageLimitPerUser:     row.usage_limit_per_user,
      createdBy:             row.created_by,
      createdAt:             row.created_at,
      updatedAt:             row.updated_at,
    }
  }
}
