import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

export class VendorsRepository {
  async create(data) {
    const { rows } = await query(
      `INSERT INTO vendors (
        name, slug, branch_code, description, logo_url, banner_url,
        phone, email, owner_name, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km,
        operating_hours, commission_rate,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, created_by, status,
        vendor_approved, account_enabled, marketplace_published,
        requested_service_radius_km, approved_service_radius_km,
        express_pickup_available
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27, $28,
        $29, $30, $31,
        $32, $33,
        $34
      )
      RETURNING id, name, slug, branch_code, description, logo_url, banner_url,
        phone, email, owner_name, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km,
        is_active, is_open, operating_hours, commission_rate, status,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, created_by, created_at, updated_at,
        vendor_approved, account_enabled, marketplace_published,
        requested_service_radius_km, approved_service_radius_km,
        express_pickup_available`,
      [
        data.name, data.slug, data.branch_code,
        data.description || null, data.logo_url || null, data.banner_url || null,
        data.phone || null, data.email || null, data.owner_name || null,
        data.address_line1, data.address_line2 || null,
        data.city, data.state, data.pincode,
        data.lat, data.lng,
        data.serviceable_pincodes || [],
        data.delivery_radius_km || 5.00,
        JSON.stringify(data.operating_hours || {}),
        data.commission_rate || 10.00,
        data.bank_account_number || null, data.bank_ifsc || null,
        data.bank_name || null, data.bank_holder_name || null,
        data.gst_number || null, data.pan_number || null,
        data.created_by, data.status || 'DRAFT',
        data.vendor_approved || false, data.account_enabled !== false, data.marketplace_published || false,
        data.requested_service_radius_km || 5.00, data.approved_service_radius_km || 5.00,
        data.express_pickup_available || false
      ]
    )
    return rows[0]
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT id, name, slug, branch_code, description, logo_url, banner_url,
        phone, email, owner_name, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km,
        is_active, is_open, operating_hours, commission_rate, status,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, created_by, created_at, updated_at,
        vendor_approved, account_enabled, marketplace_published,
        requested_service_radius_km, approved_service_radius_km,
        express_pickup_available, vendor_type,
        google_business_url, google_rating, google_review_count, google_business_name
      FROM vendors
      WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    )
    return rows[0] || null
  }

  async findByUserId(userId) {
    const { rows } = await query(
      `SELECT DISTINCT v.id, v.name, v.slug, v.branch_code, v.description, v.logo_url, v.banner_url,
        v.phone, v.email, v.owner_name, v.address_line1, v.address_line2, v.city, v.state, v.pincode,
        v.lat, v.lng, v.serviceable_pincodes, v.delivery_radius_km,
        v.is_active, v.is_open, v.operating_hours, v.commission_rate, v.status,
        v.bank_account_number, v.bank_ifsc, v.bank_name, v.bank_holder_name,
        v.gst_number, v.pan_number, v.created_by, v.created_at, v.updated_at,
        v.vendor_approved, v.account_enabled, v.marketplace_published,
        v.requested_service_radius_km, v.approved_service_radius_km,
        v.express_pickup_available, v.vendor_type,
        v.google_business_url, v.google_rating, v.google_review_count, v.google_business_name
      FROM vendors v
      LEFT JOIN vendor_employees ve ON ve.vendor_id = v.id
      WHERE (v.created_by = $1 OR ve.user_id = $1) AND v.deleted_at IS NULL
      LIMIT 1`,
      [userId]
    )
    return rows[0] || null
  }

  async update(id, data) {
    const fieldMap = {
      name: 'name',
      owner_name: 'owner_name',
      description: 'description',
      logo_url: 'logo_url',
      banner_url: 'banner_url',
      phone: 'phone',
      email: 'email',
      address_line1: 'address_line1',
      address_line2: 'address_line2',
      city: 'city',
      state: 'state',
      pincode: 'pincode',
      lat: 'lat',
      lng: 'lng',
      delivery_radius_km: 'delivery_radius_km',
      is_active: 'is_active',
      is_open: 'is_open',
      status: 'status',
      commission_rate: 'commission_rate',
      bank_account_number: 'bank_account_number',
      bank_ifsc: 'bank_ifsc',
      bank_name: 'bank_name',
      bank_holder_name: 'bank_holder_name',
      gst_number: 'gst_number',
      pan_number: 'pan_number',
      slug: 'slug',
      vendor_approved: 'vendor_approved',
      account_enabled: 'account_enabled',
      marketplace_published: 'marketplace_published',
      requested_service_radius_km: 'requested_service_radius_km',
      approved_service_radius_km: 'approved_service_radius_km',
      express_pickup_available: 'express_pickup_available'
    }

    const fields = []
    const params = []
    let idx = 1

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbCol} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (data.operating_hours !== undefined) {
      fields.push(`operating_hours = $${idx++}`)
      params.push(JSON.stringify(data.operating_hours))
    }

    if (fields.length === 0) return this.findById(id)

    fields.push('updated_at = NOW()')
    params.push(id)

    const { rows } = await query(
      `UPDATE vendors SET ${fields.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, name, slug, branch_code, description, logo_url, banner_url,
        phone, email, owner_name, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km,
        is_active, is_open, operating_hours, commission_rate, status,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, created_by, created_at, updated_at,
        vendor_approved, account_enabled, marketplace_published,
        requested_service_radius_km, approved_service_radius_km,
        express_pickup_available, vendor_type,
        google_business_url, google_rating, google_review_count, google_business_name`,
      params
    )
    return rows[0] || null
  }

  /**
   * Deliberately NOT part of update()'s field map: vendor_type is an admin-only
   * setting, and update() also backs the vendor's own profile edits.
   */
  async setVendorType(id, vendorType) {
    const { rows } = await query(
      `UPDATE vendors SET vendor_type = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, vendor_type`,
      [id, vendorType]
    )
    return rows[0] || null
  }

  /**
   * Deliberately NOT part of update()'s field map either: admin-typed
   * data, saved together so the four columns never drift out of sync.
   */
  async setGoogleBusiness(id, { url, rating, reviewCount, businessName }) {
    const { rows } = await query(
      `UPDATE vendors SET
         google_business_url = $2, google_rating = $3,
         google_review_count = $4, google_business_name = $5,
         updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, google_business_url, google_rating, google_review_count, google_business_name`,
      [id, url, rating, reviewCount, businessName]
    )
    return rows[0] || null
  }

  async addDocument(vendorId, type, fileUrl) {
    const { rows } = await query(
      `INSERT INTO vendor_documents (vendor_id, document_type, file_url)
       VALUES ($1, $2, $3)
       RETURNING id, vendor_id, document_type, file_url, status, rejection_reason, created_at`,
      [vendorId, type, fileUrl]
    )
    return rows[0]
  }

  async getDocuments(vendorId) {
    const { rows } = await query(
      `SELECT id, vendor_id, document_type, file_url, status, rejection_reason, created_at
       FROM vendor_documents
       WHERE vendor_id = $1
       ORDER BY created_at DESC`,
      [vendorId]
    )
    return rows
  }

  async updateDocumentStatus(docId, status, reason = null) {
    const { rows } = await query(
      `UPDATE vendor_documents
       SET status = $1, rejection_reason = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, vendor_id, document_type, file_url, status, rejection_reason`,
      [status, reason, docId]
    )
    return rows[0] || null
  }

  async findMany({ page = 1, limit = 20, city, status, search } = {}) {
    const offset = (page - 1) * limit
    const conditions = ['v.deleted_at IS NULL']
    const params = []
    let paramIdx = 1

    if (city) {
      conditions.push(`v.city ILIKE $${paramIdx++}`)
      params.push(`%${city}%`)
    }

    if (status) {
      conditions.push(`v.status = $${paramIdx++}`)
      params.push(status)
    }

    if (search) {
      conditions.push(`(v.name ILIKE $${paramIdx} OR v.slug ILIKE $${paramIdx} OR v.branch_code ILIKE $${paramIdx})`)
      params.push(`%${search}%`)
      paramIdx++
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT v.id, v.name, v.slug, v.branch_code, v.description, v.logo_url, v.banner_url,
          v.phone, v.email, v.address_line1, v.address_line2, v.city, v.state, v.pincode,
          v.lat, v.lng, v.delivery_radius_km, v.is_active, v.is_open, v.status, v.created_at,
          v.vendor_type,
          u.name AS owner_name,
          (SELECT COUNT(*)::int FROM vendor_services vs WHERE vs.vendor_id = v.id AND vs.deleted_at IS NULL AND vs.is_available = true) AS services_count,
          (SELECT COUNT(*)::int FROM vendor_slots vs WHERE vs.vendor_id = v.id AND vs.is_active = true) AS slots_count,
          (SELECT COALESCE(SUM(vs.max_orders), 0)::int FROM vendor_slots vs WHERE vs.vendor_id = v.id AND vs.is_active = true) AS max_capacity,
          (SELECT COUNT(*)::int FROM orders o WHERE o.vendor_id = v.id AND o.pickup_date = CURRENT_DATE AND o.status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'VENDOR_REJECTED', 'AUTO_REJECTED')) AS today_orders_count,
          (SELECT 
             CASE 
               WHEN COUNT(o.id) = 0 THEN 100
               ELSE ROUND((COUNT(CASE WHEN o.status NOT IN ('VENDOR_REJECTED', 'AUTO_REJECTED') THEN 1 END) * 100.0) / COUNT(o.id))
             END::int
           FROM orders o 
           WHERE o.vendor_id = v.id
          ) AS acceptance_rate
        FROM vendors v
        LEFT JOIN users u ON v.created_by = u.id
        WHERE ${where}
        ORDER BY v.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM vendors v WHERE ${where}`,
        params
      )
    ])

    return {
      vendors: dataResult.rows,
      total: countResult.rows[0]?.total || 0
    }
  }

  async findManyApplications({ page = 1, limit = 20, city, status, search } = {}) {
    const offset = (page - 1) * limit
    const conditions = ["va.status != 'APPROVED'"]
    const params = []
    let paramIdx = 1

    if (city) {
      conditions.push(`va.city ILIKE $${paramIdx++}`)
      params.push(`%${city}%`)
    }

    if (status) {
      conditions.push(`va.status = $${paramIdx++}`)
      params.push(status)
    }

    if (search) {
      conditions.push(`va.name ILIKE $${paramIdx++}`)
      params.push(`%${search}%`)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT va.id, va.name, NULL AS slug, NULL AS branch_code, va.description, NULL AS logo_url, NULL AS banner_url,
          va.phone, va.email, va.address_line1, va.address_line2, va.city, va.state, va.pincode,
          va.lat, va.lng,
          COALESCE(va.approved_service_radius_km, va.requested_service_radius_km) AS delivery_radius_km,
          false AS is_active, false AS is_open, va.status, va.created_at,
          COALESCE(va.owner_name, u.name) AS owner_name,
          NULL::int AS services_count,
          NULL::int AS slots_count,
          NULL::int AS max_capacity,
          0 AS today_orders_count,
          100 AS acceptance_rate
        FROM vendor_applications va
        LEFT JOIN users u ON va.owner_id = u.id
        WHERE ${where}
        ORDER BY va.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM vendor_applications va WHERE ${where}`,
        params
      )
    ])

    return {
      applications: dataResult.rows,
      total: countResult.rows[0]?.total || 0
    }
  }

  async getSlugCount(baseSlug) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM vendors WHERE slug LIKE $1`,
      [`${baseSlug}%`]
    )
    return rows[0]?.count || 0
  }

  async getDocumentById(docId) {
    const { rows } = await query(
      `SELECT id, vendor_id, document_type, file_url, status, rejection_reason, created_at
       FROM vendor_documents
       WHERE id = $1`,
      [docId]
    )
    return rows[0] || null
  }

  async getWatermarkSettings() {
    const { rows } = await query(
      `SELECT enabled, text, logo_url, position, scale, opacity
       FROM watermark_settings
       LIMIT 1`
    )
    return rows[0] || null
  }

  async hasActiveService(vendorId) {
    const { rows } = await query(
      'SELECT 1 FROM vendor_services WHERE vendor_id = $1 AND is_available = true AND deleted_at IS NULL LIMIT 1',
      [vendorId]
    )
    return rows.length > 0
  }

  // ─── Vendor Applications repository methods ───────────
  async findApplicationById(id) {
    const { rows } = await query(
      `SELECT * FROM vendor_applications WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async findApplicationByOwnerId(ownerId) {
    const { rows } = await query(
      `SELECT * FROM vendor_applications WHERE owner_id = $1 LIMIT 1`,
      [ownerId]
    )
    return rows[0] || null
  }

  async createApplication(data) {
    // phone is the same number the vendor logged in with — copy it from the
    // user account so it's visible to admin review without asking the vendor
    // to re-type (and re-verify) the number they've already authenticated with.
    const { rows } = await query(
      `INSERT INTO vendor_applications (
        owner_id, name, phone, status, requested_service_radius_km, approved_service_radius_km
      )
      SELECT $1, $2, u.phone, 'DRAFT', 5.00, 5.00
      FROM users u WHERE u.id = $1
      RETURNING *`,
      [data.owner_id, data.name]
    )
    return rows[0]
  }

  async updateApplication(id, data) {
    const fieldMap = {
      name: 'name',
      owner_name: 'owner_name',
      email: 'email',
      phone: 'phone',
      bank_account_number: 'bank_account_number',
      bank_ifsc: 'bank_ifsc',
      bank_name: 'bank_name',
      bank_holder_name: 'bank_holder_name',
      description: 'description',
      gst_number: 'gst_number',
      pan_number: 'pan_number',
      address_line1: 'address_line1',
      address_line2: 'address_line2',
      city: 'city',
      state: 'state',
      pincode: 'pincode',
      lat: 'lat',
      lng: 'lng',
      requested_service_radius_km: 'requested_service_radius_km',
      approved_service_radius_km: 'approved_service_radius_km',
      requested_daily_capacity: 'requested_daily_capacity',
      status: 'status',
      rejection_reason: 'rejection_reason'
    }

    const fields = []
    const params = []
    let idx = 1

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbCol} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (data.operating_hours !== undefined) {
      fields.push(`operating_hours = $${idx++}`)
      params.push(JSON.stringify(data.operating_hours))
    }

    if (data.correction_sections !== undefined) {
      fields.push(`correction_sections = $${idx++}`)
      params.push(data.correction_sections === null ? null : JSON.stringify(data.correction_sections))
    }

    if (fields.length === 0) return this.findApplicationById(id)

    fields.push('updated_at = NOW()')
    params.push(id)

    const { rows } = await query(
      `UPDATE vendor_applications SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      params
    )
    return rows[0] || null
  }

  async addApplicationDocument(appId, type, fileUrl) {
    // Re-uploading (the app's "Replace" action) should supersede the prior
    // document of the same type, not accumulate alongside it — otherwise the
    // admin review queue shows every past attempt as a separate pending row.
    await query(
      `DELETE FROM vendor_documents WHERE vendor_application_id = $1 AND document_type = $2`,
      [appId, type]
    )
    const { rows } = await query(
      `INSERT INTO vendor_documents (vendor_application_id, document_type, file_url)
       VALUES ($1, $2, $3)
       RETURNING id, vendor_application_id, document_type, file_url, status, rejection_reason, created_at`,
      [appId, type, fileUrl]
    )
    return rows[0]
  }

  async getApplicationDocuments(appId) {
    const { rows } = await query(
      `SELECT id, vendor_application_id, document_type, file_url, status, rejection_reason, created_at
       FROM vendor_documents
       WHERE vendor_application_id = $1
       ORDER BY created_at DESC`,
      [appId]
    )
    return rows
  }
}

