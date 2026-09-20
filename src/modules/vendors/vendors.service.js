import slugify from 'slugify'
import { getClient, query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { WatermarkService } from '../watermark/watermark.service.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { autoPublishAfterChange } from './vendor-publishing.js'

// Single source of truth for which onboarding documents block submission —
// previously duplicated as three separate hardcoded arrays across
// getApplicationMe/submitApplication/resubmitApplication, which is exactly
// the kind of drift that let migration 069's own vendor_id/vendor_application_id
// split slip through inconsistently. Keep them referencing this constant.
const REQUIRED_APPLICATION_DOCS = ['owner_identity', 'shop_photo', 'service_list']

export class VendorsService {
  constructor(repository, deps = {}) {
    this.repo = repository
    this.watermarkService = new WatermarkService()
    // Optional — only wired where a route registration passes it (see
    // vendors.routes.js). Best-effort: recalculating a rate must never
    // fail just because notification delivery had a hiccup.
    this.notificationsService = deps.notificationsService || null
  }

  async apply(userId, data) {
    // Generate unique slug
    let baseSlug = slugify(data.name, { lower: true, strict: true })
    const slugCount = await this.repo.getSlugCount(baseSlug)
    const slug = slugCount > 0 ? `${baseSlug}-${slugCount + 1}` : baseSlug

    const branchCode = 'VND-' + Math.random().toString(36).substring(2, 8).toUpperCase()

    const applicationData = {
      ...data,
      slug,
      branch_code: branchCode,
      created_by: userId,
      status: 'WAITING_FOR_APPROVAL',
      is_active: false
    }

    const vendor = await this.repo.create(applicationData)
    logger.info({ vendorId: vendor.id, userId }, 'Vendor onboarding application submitted')
    return vendor
  }

  async getProfile(userId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) return null
    const documents = await this.repo.getDocuments(vendor.id)
    return {
      ...vendor,
      documents
    }
  }

  async updateProfile(userId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) {
      throw { statusCode: 404, message: 'Vendor profile not found' }
    }
    // Cannot update status directly
    delete data.status
    delete data.is_active
    delete data.created_by
    return this.repo.update(vendor.id, data)
  }

  async uploadDocument(userId, type, fileUrl) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) {
      throw { statusCode: 404, message: 'Vendor profile not found' }
    }
    return this.repo.addDocument(vendor.id, type, fileUrl)
  }

  async adminList(filters) {
    const [vendorsResult, applicationsResult] = await Promise.all([
      this.repo.findMany(filters),
      this.repo.findManyApplications(filters)
    ])
    const merged = [...applicationsResult.applications, ...vendorsResult.vendors]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    const page = Number(filters.page) || 1
    const limit = Number(filters.limit) || 20
    const start = (page - 1) * limit
    return {
      vendors: merged.slice(start, start + limit),
      total: applicationsResult.total + vendorsResult.total
    }
  }

  // A vendor_applications row is never deleted on approval — it just flips to
  // APPROVED while a brand-new `vendors` row (a different id) becomes the
  // live entity everything else in the system reads from. Every admin
  // endpoint that takes an id from the /vendor-applications/:id URL has to
  // resolve to whichever of the two rows is actually still "live" for that
  // id, or edits after approval would silently write to an orphaned,
  // no-longer-used application record.
  async _resolveReviewTarget(id) {
    const app = await this.repo.findApplicationById(id)
    if (app && app.status !== 'APPROVED') {
      return { kind: 'application', record: app }
    }
    const vendor = app ? await this.repo.findByUserId(app.owner_id) : await this.repo.findById(id)
    if (vendor) {
      return { kind: 'vendor', record: vendor }
    }
    // Approved application whose promotion to `vendors` never completed —
    // extremely unlikely, but fall back to the application rather than 404.
    return app ? { kind: 'application', record: app } : null
  }

  async adminGetDetails(id) {
    const target = await this._resolveReviewTarget(id)
    if (!target) return null
    const documents = target.kind === 'vendor'
      ? await this.repo.getDocuments(target.record.id)
      : await this.repo.getApplicationDocuments(target.record.id)
    return { ...target.record, documents }
  }

  async adminUpdateDetails(id, data) {
    const target = await this._resolveReviewTarget(id)
    if (!target) {
      throw { statusCode: 404, message: 'Vendor application not found' }
    }
    // Deliberately excludes phone — it's copied from the vendor's login
    // account and isn't editable by anyone through this review UI.
    const updates = {}
    if (data.owner_name !== undefined) updates.owner_name = data.owner_name
    if (data.name !== undefined) updates.name = data.name
    if (data.description !== undefined) updates.description = data.description
    if (data.email !== undefined) updates.email = data.email
    if (data.gst_number !== undefined) updates.gst_number = data.gst_number
    if (data.pan_number !== undefined) updates.pan_number = data.pan_number
    if (data.bank_account_number !== undefined) updates.bank_account_number = data.bank_account_number
    if (data.bank_ifsc !== undefined) updates.bank_ifsc = data.bank_ifsc
    if (data.bank_name !== undefined) updates.bank_name = data.bank_name
    if (data.bank_holder_name !== undefined) updates.bank_holder_name = data.bank_holder_name

    return target.kind === 'vendor'
      ? this.repo.update(target.record.id, updates)
      : this.repo.updateApplication(target.record.id, updates)
  }

  async adminReview(id, { status, approvedRadius, approvedDailyCapacity, documentReviews, rejectionReason, correctionSections }) {
    const target = await this._resolveReviewTarget(id)
    if (!target) {
      throw { statusCode: 404, message: 'Application or Vendor not found' }
    }

    if (target.kind === 'vendor') {
      // Already approved and promoted — nothing left to "review". The only
      // actions that still make sense here are adjusting the approved
      // radius or flipping an operational status like SUSPENDED.
      const updates = {}
      if (approvedRadius != null) {
        updates.approved_service_radius_km = approvedRadius
        updates.delivery_radius_km = approvedRadius
      }
      if (status && status !== target.record.status) {
        updates.status = status
        if (status === 'SUSPENDED') {
          updates.is_active = false
          updates.account_enabled = false
        } else if (status === 'APPROVED') {
          updates.is_active = true
          updates.vendor_approved = true
          updates.account_enabled = true
        }
      }
      return this.repo.update(target.record.id, updates)
    }

    const app = target.record

    const validStatuses = ['APPROVED', 'REJECTED', 'CORRECTION_REQUIRED', 'SUSPENDED']
    if (!validStatuses.includes(status)) {
      throw { statusCode: 400, message: 'Invalid vendor status' }
    }

    const updates = { status }
    if (status === 'APPROVED') {
      updates.approved_service_radius_km = approvedRadius || app.requested_service_radius_km
      // A prior correction/rejection note shouldn't linger once the vendor is approved.
      updates.rejection_reason = null
      updates.correction_sections = null
    } else if (status === 'CORRECTION_REQUIRED') {
      updates.rejection_reason = rejectionReason || null
      updates.correction_sections = Array.isArray(correctionSections) ? correctionSections : []
    } else if (status === 'REJECTED') {
      updates.rejection_reason = rejectionReason || 'Your application did not meet our requirements.'
      updates.correction_sections = null
    }

    if (Array.isArray(documentReviews)) {
      for (const dr of documentReviews) {
        await this.repo.updateDocumentStatus(dr.documentId, dr.status, dr.rejectionReason)
      }
    }

    const updatedApp = await this.repo.updateApplication(id, updates)

    if (status === 'APPROVED') {
      await this._promoteApplicationToVendor(app, approvedRadius, approvedDailyCapacity)
    }

    logger.info({ vendorApplicationId: id, status, approvedRadius }, 'Vendor application reviewed by admin')
    return updatedApp
  }

  // Turns a vendor_applications row into a live vendors + vendor_employees
  // row. Shared by adminReview's APPROVED branch and the
  // ALLOW_AUTO_APPROVE_VENDOR dev shortcut in submitApplication below — both
  // need to do this identically.
  async _promoteApplicationToVendor(app, approvedRadius, approvedDailyCapacity) {
    let baseSlug = slugify(app.name, { lower: true, strict: true })
    const slugCount = await this.repo.getSlugCount(baseSlug)
    const slug = slugCount > 0 ? `${baseSlug}-${slugCount + 1}` : baseSlug
    const branchCode = 'VND-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    const dailyCapacity = approvedDailyCapacity || app.requested_daily_capacity

    const vendor = await this.repo.create({
      name: app.name,
      slug,
      branch_code: branchCode,
      description: app.description,
      email: app.email,
      phone: app.phone,
      owner_name: app.owner_name,
      address_line1: app.address_line1,
      address_line2: app.address_line2,
      city: app.city,
      state: app.state,
      pincode: app.pincode,
      lat: app.lat,
      lng: app.lng,
      requested_service_radius_km: app.requested_service_radius_km,
      approved_service_radius_km: approvedRadius || app.requested_service_radius_km,
      delivery_radius_km: approvedRadius || app.requested_service_radius_km,
      bank_account_number: app.bank_account_number,
      bank_ifsc: app.bank_ifsc,
      bank_name: app.bank_name,
      bank_holder_name: app.bank_holder_name,
      gst_number: app.gst_number,
      pan_number: app.pan_number,
      operating_hours: dailyCapacity ? { max_orders_per_day: dailyCapacity } : {},
      created_by: app.owner_id,
      status: 'APPROVED',
      vendor_approved: true,
      account_enabled: true,
      marketplace_published: false
    })

    await query(
      `UPDATE vendor_documents SET vendor_id = $1, vendor_application_id = NULL WHERE vendor_application_id = $2`,
      [vendor.id, app.id]
    )

    await query(
      `INSERT INTO vendor_employees (vendor_id, user_id, role, is_active)
       VALUES ($1, $2, 'VENDOR_OWNER', true)
       ON CONFLICT (vendor_id, user_id) DO UPDATE SET role = 'VENDOR_OWNER', is_active = true`,
      [vendor.id, app.owner_id]
    )

    return vendor
  }

  _isAutoApproveVendorEnabled() {
    // Hard-blocked in production regardless of the flag, matching the
    // _isDemoOtpEnabled pattern in AuthService — defense-in-depth against a
    // misconfigured ALLOW_AUTO_APPROVE_VENDOR in prod.
    if (env.NODE_ENV === 'production') return false
    return env.ALLOW_AUTO_APPROVE_VENDOR
  }

  async previewKycDocument(docId, user) {
    const doc = await this.repo.getDocumentById(docId)
    if (!doc) {
      throw { statusCode: 404, message: 'Document not found' }
    }

    const isAdmin = user.role === 'ADMIN' || user.platform_role === 'ADMIN'
    if (!isAdmin) {
      const userVendor = await this.repo.findByUserId(user.id)
      if (!userVendor || userVendor.id !== doc.vendor_id) {
        throw { statusCode: 403, message: 'Forbidden' }
      }
    }

    const vendor = await this.repo.findById(doc.vendor_id)
    const settings = await this.repo.getWatermarkSettings() || { enabled: true, text: 'For LNDRY Verification Only', position: 'center', scale: 1.0, opacity: 0.4 }

    emitAudit('kyc_document_viewed', {
      actor_user_id: user.id,
      actor_role: user.role || user.platform_role || null,
      actor_shop_id: doc.vendor_id,
      target_type: 'vendor_document',
      target_id: docId,
      before: null,
      after: { document_type: doc.document_type },
    })

    return this.watermarkService.processKycPreview(
      doc.file_url,
      vendor ? vendor.branch_code : 'VND-UNKNOWN',
      settings
    )
  }

  async createApplication(userId, data) {
    const existing = await this.repo.findApplicationByOwnerId(userId)
    if (existing) {
      return existing
    }

    const applicationData = {
      owner_id: userId,
      name: data.name || 'My Laundry Business',
    }

    return this.repo.createApplication(applicationData)
  }

  async getApplicationMe(userId) {
    const app = await this.repo.findApplicationByOwnerId(userId)
    if (!app) {
      throw { statusCode: 404, message: 'No onboarding application found' }
    }
    const documents = await this.repo.getApplicationDocuments(app.id)
    
    const missingSteps = []
    if (!app.bank_account_number || !app.bank_ifsc) {
      missingSteps.push('bank_details')
    }
    if (!app.gst_number && !app.pan_number) {
      missingSteps.push('tax_details')
    }
    const uploadedDocs = documents.map(d => d.document_type)
    for (const docType of REQUIRED_APPLICATION_DOCS) {
      if (!uploadedDocs.includes(docType)) {
        missingSteps.push(`document:${docType}`)
      }
    }
    if (app.requested_daily_capacity == null) {
      missingSteps.push('capacity')
    }

    return {
      application: {
        ...app,
        documents
      },
      missing_steps: missingSteps,
    }
  }

  async verifyApplicationAccess(userId, applicationId) {
    const app = await this.repo.findApplicationById(applicationId)
    if (!app) {
      throw { statusCode: 404, message: 'Application not found' }
    }
    if (app.owner_id !== userId) {
      throw { statusCode: 403, message: 'Forbidden' }
    }
    return app
  }

  // `repo.updateApplication` only returns the vendor_applications row itself
  // (RETURNING *), with no `documents` field. The onboarding wizard keeps
  // whatever application object each step's PATCH call returns as its local
  // state, so without this, every step save silently wiped the previously
  // uploaded documents out of the app's in-memory state (though never out of
  // the database) — the Documents step would then show "Upload" again for
  // files that were already there, until the next full refetch restored them.
  async _withDocuments(app) {
    const documents = await this.repo.getApplicationDocuments(app.id)
    return { ...app, documents }
  }

  async updateApplicationOwner(userId, appId, data) {
    await this.verifyApplicationAccess(userId, appId)
    const updates = {}
    if (data.owner_name) updates.owner_name = data.owner_name
    if (data.email) updates.email = data.email
    if (data.bank_account_number) updates.bank_account_number = data.bank_account_number
    if (data.bank_ifsc) updates.bank_ifsc = data.bank_ifsc
    if (data.bank_name) updates.bank_name = data.bank_name
    if (data.bank_holder_name) updates.bank_holder_name = data.bank_holder_name

    return this._withDocuments(await this.repo.updateApplication(appId, updates))
  }

  async updateApplicationBusiness(userId, appId, data) {
    await this.verifyApplicationAccess(userId, appId)
    const updates = {}
    if (data.name) updates.name = data.name
    if (data.description) updates.description = data.description
    if (data.operating_hours) updates.operating_hours = data.operating_hours
    if (data.gst_number) updates.gst_number = data.gst_number
    if (data.pan_number) updates.pan_number = data.pan_number

    return this._withDocuments(await this.repo.updateApplication(appId, updates))
  }

  async updateApplicationLocation(userId, appId, data) {
    await this.verifyApplicationAccess(userId, appId)
    const updates = {}
    if (data.address_line1) updates.address_line1 = data.address_line1
    if (data.address_line2) updates.address_line2 = data.address_line2
    if (data.city) updates.city = data.city
    if (data.state) updates.state = data.state
    if (data.pincode) updates.pincode = data.pincode
    if (data.lat !== undefined) updates.lat = data.lat
    if (data.lng !== undefined) updates.lng = data.lng

    return this._withDocuments(await this.repo.updateApplication(appId, updates))
  }

  async updateApplicationRadius(userId, appId, data) {
    await this.verifyApplicationAccess(userId, appId)
    const updates = {}
    if (data.requested_radius_km !== undefined) {
      updates.requested_service_radius_km = data.requested_radius_km
    }
    if (data.requested_daily_capacity !== undefined) {
      updates.requested_daily_capacity = data.requested_daily_capacity
    }
    return this._withDocuments(await this.repo.updateApplication(appId, updates))
  }

  async addApplicationDocument(userId, appId, type, fileUrl) {
    await this.verifyApplicationAccess(userId, appId)
    return this.repo.addApplicationDocument(appId, type, fileUrl)
  }

  async deleteApplicationDocument(userId, appId, docId) {
    await this.verifyApplicationAccess(userId, appId)
    const doc = await this.repo.getDocumentById(docId)
    if (!doc || doc.vendor_application_id !== appId) {
      throw { statusCode: 404, message: 'Document not found' }
    }
    await query('DELETE FROM vendor_documents WHERE id = $1', [docId])
    return { success: true }
  }

  async submitApplication(userId, appId) {
    const app = await this.verifyApplicationAccess(userId, appId)
    if (app.status !== 'DRAFT' && app.status !== 'CORRECTION_REQUIRED') {
      throw { statusCode: 400, message: 'Application is already submitted' }
    }
    const docs = await this.repo.getApplicationDocuments(appId)
    const uploadedTypes = docs.map(d => d.document_type)
    const missingDocs = REQUIRED_APPLICATION_DOCS.filter(d => !uploadedTypes.includes(d))
    if (missingDocs.length > 0 || app.requested_daily_capacity == null) {
      throw { statusCode: 400, message: `Missing required onboarding fields: ${[...missingDocs, ...(app.requested_daily_capacity == null ? ['requested daily capacity'] : [])].join(', ')}` }
    }

    if (this._isAutoApproveVendorEnabled()) {
      const updatedApp = await this.repo.updateApplication(appId, {
        status: 'APPROVED',
        rejection_reason: null,
        correction_sections: null
      })
      await this._promoteApplicationToVendor(updatedApp, updatedApp.requested_service_radius_km, updatedApp.requested_daily_capacity)
      logger.info({ vendorApplicationId: appId, userId }, 'Vendor application auto-approved (ALLOW_AUTO_APPROVE_VENDOR)')
      return this._withDocuments(updatedApp)
    }

    return this.repo.updateApplication(appId, { status: 'WAITING_FOR_APPROVAL' })
  }

  async resubmitApplication(userId, appId) {
    const app = await this.verifyApplicationAccess(userId, appId)
    if (app.status !== 'CORRECTION_REQUIRED') {
      throw { statusCode: 400, message: 'Application is not in CORRECTION_REQUIRED status' }
    }
    const docs = await this.repo.getApplicationDocuments(appId)
    const uploadedTypes = docs.map(d => d.document_type)
    const missingDocs = REQUIRED_APPLICATION_DOCS.filter(d => !uploadedTypes.includes(d))
    if (missingDocs.length > 0 || app.requested_daily_capacity == null) {
      throw { statusCode: 400, message: `Missing required onboarding fields: ${[...missingDocs, ...(app.requested_daily_capacity == null ? ['requested daily capacity'] : [])].join(', ')}` }
    }
    return this.repo.updateApplication(appId, {
      status: 'WAITING_FOR_APPROVAL',
      rejection_reason: null,
      correction_sections: null,
    })
  }

  async publishProfile(userId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) {
      throw { statusCode: 404, message: 'Vendor profile not found' }
    }
    if (vendor.status !== 'APPROVED') {
      throw { statusCode: 400, message: 'Cannot publish vendor profile until application is APPROVED' }
    }
    const hasService = await this.repo.hasActiveService(vendor.id)
    if (!hasService) {
      throw { statusCode: 400, message: 'Cannot publish vendor without at least one active service' }
    }

    const published = await this.repo.update(vendor.id, { is_active: true, marketplace_published: true })
    // A vendor that has published themselves has used the one automatic
    // publish, so an admin who unpublishes them later is not overruled.
    await query(
      `UPDATE vendors SET marketplace_auto_published_at = COALESCE(marketplace_auto_published_at, NOW()) WHERE id = $1`,
      [vendor.id]
    )
    return published
  }

  async getPublicPreview(userId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) {
      throw { statusCode: 404, message: 'Vendor profile not found' }
    }
    const documents = await this.repo.getDocuments(vendor.id)

    // vendors has no rating/review_count columns — the customer-facing
    // discovery queries already compute this live from `reviews`, but the
    // vendor's own profile (what the dashboard's Avg Rating/Total Reviews
    // banner reads) never did, so it always showed "N/A" / 0 no matter how
    // many reviews came in.
    const { rows: ratingRows } = await query(
      `SELECT
         AVG(vendor_rating)::numeric(2,1) AS rating,
         COUNT(*)::int AS review_count
       FROM reviews
       WHERE vendor_id = $1 AND deleted_at IS NULL`,
      [vendor.id]
    )
    const { rating, review_count: reviewCount } = ratingRows[0]

    return {
      ...vendor,
      // null (not 0) with zero reviews, so the vendor app's "N/A" fallback
      // still shows for a genuinely unrated vendor instead of a misleading 0.
      rating: rating !== null ? Number(rating) : null,
      review_count: reviewCount,
      documents
    }
  }

  async updateProfileLocation(userId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) {
      throw { statusCode: 404, message: 'Vendor profile not found' }
    }
    const updates = {
      address_line1: data.address_line1,
      address_line2: data.address_line2,
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      lat: data.lat,
      lng: data.lng,
      status: 'WAITING_FOR_APPROVAL',
      is_active: false
    }
    return this.repo.update(vendor.id, updates)
  }

  async getVendorCategories() {
    // The table was renamed categories -> service_categories (migration 062);
    // this query still referenced the old name and old column names
    // (image/display_order instead of image_url/sort_order), so it threw a
    // 500 on every call. Fixed to match the real schema.
    const { rows } = await query(
      `SELECT id, name, slug, description, image_url, sort_order
       FROM service_categories
       WHERE is_active = true
       ORDER BY sort_order ASC, name ASC`
    )
    return rows
  }

  // ─── Vendor services & garment rates — shared core (vendorId-first) ────
  // Reused by both the vendor's own self-service catalogue endpoints and
  // the admin equivalents further below, so there's one implementation of
  // each operation instead of a parallel admin copy.

  async _getVendorServicesForVendor(vendorId, { status, categoryId, page = 1, limit = 20 } = {}) {
    const conditions = ['vs.vendor_id = $1', 'vs.deleted_at IS NULL']
    const params = [vendorId]
    let idx = 2

    if (categoryId) {
      conditions.push(`vs.category_id = $${idx++}`)
      params.push(categoryId)
    }

    if (status !== undefined) {
      conditions.push(`vs.is_available = $${idx++}`)
      params.push(status === 'active' || status === 'true')
    }

    const offset = (page - 1) * limit
    const where = conditions.join(' AND ')

    const { rows } = await query(
      `SELECT vs.id, vs.name, vs.description, vs.inclusions, vs.exclusions,
              vs.completion_time_hours, vs.image_asset_id, vs.status, vs.is_available,
              vs.category_id, sc.name AS category_name,
              COALESCE((vs.price * 100)::int, 0) AS price_per_piece,
              COALESCE(vs.min_weight_kg, 1.0) AS min_weight_kg,
              vs.approval_status, vs.rejection_reason,
              (SELECT vsr.override_reason FROM vendor_service_rates vsr
                WHERE vsr.vendor_service_id = vs.id AND vsr.override_reason IS NOT NULL
                ORDER BY vsr.override_at DESC LIMIT 1) AS latest_override_reason,
              (SELECT vsr.override_at FROM vendor_service_rates vsr
                WHERE vsr.vendor_service_id = vs.id AND vsr.override_reason IS NOT NULL
                ORDER BY vsr.override_at DESC LIMIT 1) AS latest_override_at
       FROM vendor_services vs
       LEFT JOIN service_categories sc ON vs.category_id = sc.id
       WHERE ${where}
       ORDER BY sc.name, vs.name
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `SELECT COUNT(*)::int as total
       FROM vendor_services vs
       WHERE ${where}`,
      params
    )

    return {
      services: rows,
      total: countRes.rows[0].total,
      page,
      limit
    }
  }

  async getVendorServices(userId, opts = {}) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._getVendorServicesForVendor(vendor.id, opts)
  }

  async adminGetVendorServices(id, opts = {}) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._getVendorServicesForVendor(vendorId, opts)
  }

  /**
   * Flat, vendor-scoped list of every garment-type this vendor can actually
   * charge for, across all their active+approved services in one call —
   * built for the reconciliation "move item to a different service" /
   * "add a new service" picker UI, which needs category + service + garment
   * name + unit + price + image together rather than the paginated
   * per-service shape `getVendorServices`/`getVendorServiceDetails` return.
   */
  async getReconciliationCatalogue(userId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const { rows } = await query(
      `SELECT vsr.garment_type_id, gt.name AS garment_name, gt.unit, vsr.rate_paise,
              vs.id AS vendor_service_id, vs.name AS service_name,
              sc.id AS category_id, sc.name AS category_name,
              COALESCE(vs.image_asset_id, sc.image_url) AS image_url,
              gt.images->>0 AS garment_image_url
       FROM vendor_service_rates vsr
       JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
       JOIN garment_types gt ON vsr.garment_type_id = gt.id
       LEFT JOIN service_categories sc ON gt.category_id = sc.id
       WHERE vs.vendor_id = $1 AND vsr.is_active = true AND vs.is_available = true
         AND vs.deleted_at IS NULL AND vs.approval_status = 'APPROVED' AND gt.is_active = true
       ORDER BY sc.name, vs.name, gt.name`,
      [vendor.id]
    )
    return rows
  }

  // `reviewCtx` lets an admin-initiated create bypass the PENDING review
  // cycle — the admin IS the approver, so a service they add on a vendor's
  // behalf shouldn't need a second admin to re-approve it.
  async _createVendorServiceForVendor(vendorId, payload, reviewCtx = null) {
    const categoryId = typeof payload === 'object' ? payload.category_id : payload
    const customName = typeof payload === 'object' ? payload.name : null
    const customDesc = typeof payload === 'object' ? payload.description : null
    const customPrice = typeof payload === 'object' ? (payload.price_per_piece !== undefined ? payload.price_per_piece / 100 : (payload.price !== undefined ? payload.price : null)) : null
    const customMinWeight = typeof payload === 'object' ? (payload.min_weight_kg !== undefined ? payload.min_weight_kg : 1.0) : 1.0
    const isAvailable = typeof payload === 'object' ? (payload.is_available !== undefined ? payload.is_available : true) : false

    const catRes = await query('SELECT name, description FROM service_categories WHERE id = $1', [categoryId])
    const cat = catRes.rows[0]
    if (!cat) throw { statusCode: 404, message: 'Service category not found' }

    const serviceName = customName || cat.name
    const serviceDesc = customDesc || cat.description
    const serviceStatus = customName ? 'PUBLISHED' : 'DRAFT'
    const approvalStatus = reviewCtx ? 'APPROVED' : 'PENDING'
    const approvedAt = reviewCtx ? new Date() : null
    const approvedBy = reviewCtx ? reviewCtx.adminUserId : null

    // Every vendor-initiated (re)submission through this endpoint requires
    // a fresh admin review before it can go live to customers (see
    // discovery.routes.js's `approval_status = 'APPROVED'` gate) — unless
    // an admin is the one creating it (reviewCtx set), in which case it's
    // approved immediately.
    const { rows: vsRows } = await query(
      `INSERT INTO vendor_services (vendor_id, category_id, name, description, price, min_weight_kg, status, is_available, approval_status, approved_at, approved_by, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
       ON CONFLICT (vendor_id, category_id) DO UPDATE SET
         deleted_at = NULL,
         status = $7,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = COALESCE(EXCLUDED.price, vendor_services.price),
         min_weight_kg = COALESCE(EXCLUDED.min_weight_kg, vendor_services.min_weight_kg),
         is_available = EXCLUDED.is_available,
         approval_status = $9,
         approved_at = $10,
         approved_by = $11,
         rejection_reason = NULL,
         updated_at = NOW()
       RETURNING id, status, name, description, price, min_weight_kg, is_available, approval_status`,
      [vendorId, categoryId, serviceName, serviceDesc, customPrice, customMinWeight, serviceStatus, isAvailable, approvalStatus, approvedAt, approvedBy]
    )
    const vs = vsRows[0]

    // A resubmission supersedes any earlier admin price-recalculation note
    // on this service's rates — the vendor is actively addressing it, so
    // it shouldn't keep showing as an unresolved flag.
    await query(
      `UPDATE vendor_service_rates SET override_reason = NULL, override_at = NULL
       WHERE vendor_service_id = $1 AND override_reason IS NOT NULL`,
      [vs.id]
    )

    const { rows: gts } = await query('SELECT id FROM garment_types WHERE category_id = $1 AND is_active = true', [categoryId])
    for (const gt of gts) {
      await query(
        `INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise, is_active)
         VALUES ($1, $2, 0, true)
         ON CONFLICT (vendor_service_id, garment_type_id) DO NOTHING`,
        [vs.id, gt.id]
      )
    }

    return { 
      id: vs.id, 
      status: vs.status, 
      category_id: categoryId, 
      category: cat.name,
      name: vs.name,
      description: vs.description,
      price_per_piece: vs.price ? Math.round(vs.price * 100) : 0,
      min_weight_kg: vs.min_weight_kg ? Number(vs.min_weight_kg) : 1.0,
      is_available: vs.is_available,
      approval_status: vs.approval_status
    }
  }

  async createVendorServiceDraft(userId, payload) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._createVendorServiceForVendor(vendor.id, payload)
  }

  async adminCreateVendorService(id, payload, adminUserId) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._createVendorServiceForVendor(vendorId, payload, { adminUserId })
  }

  async _getVendorServiceDetailsForVendor(vendorId, serviceId) {
    const serviceRes = await query(
      `SELECT vs.id, vs.name, vs.description, vs.inclusions, vs.exclusions,
              vs.completion_time_hours, vs.image_asset_id, vs.status, vs.is_available, vs.category_id,
              sc.name AS category_name,
              COALESCE((vs.price * 100)::int, 0) AS price_per_piece,
              COALESCE(vs.min_weight_kg, 1.0) AS min_weight_kg,
              vs.approval_status, vs.rejection_reason
       FROM vendor_services vs
       LEFT JOIN service_categories sc ON vs.category_id = sc.id
       WHERE vs.id = $1 AND vs.vendor_id = $2 AND vs.deleted_at IS NULL`,
      [serviceId, vendorId]
    )

    const service = serviceRes.rows[0]
    if (!service) throw { statusCode: 404, message: 'Vendor service not found' }

    const { rows: rates } = await query(
      `SELECT vsr.id AS rate_id, vsr.rate_paise, vsr.is_active, vsr.override_reason, vsr.override_at,
              gt.id AS garment_type_id, gt.name AS garment_name, gt.unit
       FROM vendor_service_rates vsr
       JOIN garment_types gt ON vsr.garment_type_id = gt.id
       WHERE vsr.vendor_service_id = $1 AND gt.is_active = true`,
      [serviceId]
    )

    return {
      category: { name: service.category_name, id: service.category_id },
      service,
      garments: rates.map(r => ({
        garment_rate_id: r.garment_type_id,
        garment_name: r.garment_name,
        unit: r.unit,
        rate_paise: r.rate_paise,
        is_available: r.is_active,
        vendor_service_id: serviceId,
        override_reason: r.override_reason,
        override_at: r.override_at
      }))
    }
  }

  async getVendorServiceDetails(userId, serviceId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._getVendorServiceDetailsForVendor(vendor.id, serviceId)
  }

  async adminGetVendorServiceDetails(id, serviceId) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._getVendorServiceDetailsForVendor(vendorId, serviceId)
  }

  // Same reviewCtx bypass as _createVendorServiceForVendor above — an
  // admin's own content/pricing edit is approved immediately.
  async _updateVendorServiceForVendor(vendorId, serviceId, payload, reviewCtx = null) {
    const isAvailable = typeof payload === 'object' ? payload.is_available : payload

    if (typeof payload === 'object' && (payload.name !== undefined || payload.description !== undefined || payload.price_per_piece !== undefined || payload.min_weight_kg !== undefined)) {
      const updates = []
      const params = []
      let idx = 1

      if (payload.name !== undefined) { updates.push(`name = $${idx++}`); params.push(payload.name) }
      if (payload.description !== undefined) { updates.push(`description = $${idx++}`); params.push(payload.description) }
      if (payload.price_per_piece !== undefined) { updates.push(`price = $${idx++}`); params.push(payload.price_per_piece / 100) }
      else if (payload.price !== undefined) { updates.push(`price = $${idx++}`); params.push(payload.price) }
      if (payload.min_weight_kg !== undefined) { updates.push(`min_weight_kg = $${idx++}`); params.push(payload.min_weight_kg) }
      if (payload.is_available !== undefined) { updates.push(`is_available = $${idx++}`); params.push(payload.is_available) }

      // Content/pricing edits require a fresh admin review, same as a new
      // submission — only the plain availability-toggle branch below skips
      // this, and an admin's own edit (reviewCtx set) skips it too.
      if (reviewCtx) {
        updates.push(`approval_status = 'APPROVED'`, `approved_at = NOW()`, `approved_by = $${idx++}`, `rejection_reason = NULL`)
        params.push(reviewCtx.adminUserId)
      } else {
        updates.push(`approval_status = 'PENDING'`, `approved_at = NULL`, `approved_by = NULL`, `rejection_reason = NULL`)
      }
      updates.push(`updated_at = NOW()`)
      params.push(serviceId, vendorId)

      const res = await query(
        `UPDATE vendor_services
         SET ${updates.join(', ')}
         WHERE id = $${idx++} AND vendor_id = $${idx++} AND deleted_at IS NULL
         RETURNING id, name, description, COALESCE((price * 100)::int, 0) AS price_per_piece, COALESCE(min_weight_kg, 1.0) AS min_weight_kg, is_available, category_id, status, approval_status`,
        params
      )
      if (!res.rows[0]) throw { statusCode: 404, message: 'Vendor service not found' }

      // Same as a new submission — resubmitting supersedes any earlier
      // admin price-recalculation note on this service's rates.
      await query(
        `UPDATE vendor_service_rates SET override_reason = NULL, override_at = NULL
         WHERE vendor_service_id = $1 AND override_reason IS NOT NULL`,
        [serviceId]
      )

      return res.rows[0]
    } else {
      await query(
        `UPDATE vendor_services
         SET is_available = $1, updated_at = NOW()
         WHERE id = $2 AND vendor_id = $3`,
        [isAvailable !== false, serviceId, vendorId]
      )
      return { success: true, id: serviceId, is_available: isAvailable !== false }
    }
  }

  async updateVendorService(userId, serviceId, payload) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._updateVendorServiceForVendor(vendor.id, serviceId, payload)
  }

  async adminUpdateVendorService(id, serviceId, payload, adminUserId) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._updateVendorServiceForVendor(vendorId, serviceId, payload, { adminUserId })
  }

  async _deleteVendorServiceForVendor(vendorId, serviceId) {
    await query(
      `UPDATE vendor_services
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2`,
      [serviceId, vendorId]
    )

    return { success: true }
  }

  async deleteVendorService(userId, serviceId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._deleteVendorServiceForVendor(vendor.id, serviceId)
  }

  async adminDeleteVendorService(id, serviceId) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._deleteVendorServiceForVendor(vendorId, serviceId)
  }

  async _addGarmentRateForVendor(vendorId, serviceId, data) {
    const vsRes = await query('SELECT category_id FROM vendor_services WHERE id = $1 AND vendor_id = $2', [serviceId, vendorId])
    const vs = vsRes.rows[0]
    if (!vs) throw { statusCode: 404, message: 'Vendor service not found' }

    let gtId = data.garment_type_id
    if (!gtId && data.garment_type_name) {
      const slug = slugify(data.garment_type_name, { lower: true, strict: true }) + '-' + Math.random().toString(36).substring(2, 6)
      const gtRes = await query(
        `INSERT INTO garment_types (name, slug, unit, category_id, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (slug) DO UPDATE SET is_active = true
         RETURNING id`,
        [data.garment_type_name, slug, data.rate_unit || 'piece', vs.category_id]
      )
      gtId = gtRes.rows[0].id
    }

    if (!gtId) throw { statusCode: 400, message: 'garment_type_id or garment_type_name is required' }

    const ratePaise = parseInt(data.rate_paise, 10) || 0
    await query(
      `INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (vendor_service_id, garment_type_id)
       DO UPDATE SET rate_paise = $3, is_active = true`,
      [serviceId, gtId, ratePaise]
    )

    return { garment_type_id: gtId, rate_paise: ratePaise, is_available: true }
  }

  async addGarmentRate(userId, serviceId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._addGarmentRateForVendor(vendor.id, serviceId, data)
  }

  async adminAddGarmentRate(id, serviceId, data) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._addGarmentRateForVendor(vendorId, serviceId, data)
  }

  async _updateGarmentRateForVendor(vendorId, serviceId, garmentTypeId, data) {
    const updates = []
    const params = []
    let idx = 1

    if (data.rate_paise !== undefined) {
      updates.push(`rate_paise = $${idx++}`)
      params.push(parseInt(data.rate_paise, 10) || 0)
    }

    if (data.is_available !== undefined) {
      updates.push(`is_active = $${idx++}`)
      params.push(data.is_available === true)
    }

    if (updates.length === 0) return { success: true }

    params.push(serviceId, garmentTypeId)
    await query(
      `UPDATE vendor_service_rates
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE vendor_service_id = $${idx} AND garment_type_id = $${idx + 1}`,
      params
    )

    return { success: true }
  }

  async updateGarmentRate(userId, serviceId, garmentTypeId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._updateGarmentRateForVendor(vendor.id, serviceId, garmentTypeId, data)
  }

  async adminUpdateGarmentRate(id, serviceId, garmentTypeId, data) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._updateGarmentRateForVendor(vendorId, serviceId, garmentTypeId, data)
  }

  async _deleteGarmentRateForVendor(vendorId, serviceId, garmentTypeId) {
    await query(
      `UPDATE vendor_service_rates
       SET is_active = false, updated_at = NOW()
       WHERE vendor_service_id = $1 AND garment_type_id = $2`,
      [serviceId, garmentTypeId]
    )

    return { success: true }
  }

  async deleteGarmentRate(userId, serviceId, garmentTypeId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._deleteGarmentRateForVendor(vendor.id, serviceId, garmentTypeId)
  }

  async adminDeleteGarmentRate(id, serviceId, garmentTypeId) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._deleteGarmentRateForVendor(vendorId, serviceId, garmentTypeId)
  }

  async _bulkUpsertGarmentRatesForVendor(vendorId, serviceId, items) {
    if (items.length === 0) return { success: true }

    // Set-based upsert instead of one query per item — a vendor saving
    // prices for a whole category's worth of subcategories in one action
    // should cost one round-trip, not N.
    const garmentTypeIds = []
    const ratesPaise = []
    const actives = []
    for (const item of items) {
      garmentTypeIds.push(item.garment_type_id || item.garment_rate_id)
      ratesPaise.push(parseInt(item.rate_paise, 10) || 0)
      actives.push(item.is_available !== false)
    }

    await query(
      `INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise, is_active)
       SELECT $1, gt_id, rate, active
       FROM UNNEST($2::uuid[], $3::int[], $4::bool[]) AS t(gt_id, rate, active)
       ON CONFLICT (vendor_service_id, garment_type_id)
       DO UPDATE SET rate_paise = EXCLUDED.rate_paise, is_active = EXCLUDED.is_active, updated_at = NOW()`,
      [serviceId, garmentTypeIds, ratesPaise, actives]
    )

    return { success: true }
  }

  async bulkUpsertGarmentRates(userId, serviceId, items) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._bulkUpsertGarmentRatesForVendor(vendor.id, serviceId, items)
  }

  async adminBulkUpsertGarmentRates(id, serviceId, items) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._bulkUpsertGarmentRatesForVendor(vendorId, serviceId, items)
  }

  async publishService(userId, serviceId) {
    return this.updateVendorService(userId, serviceId, true)
  }

  async unpublishService(userId, serviceId, reason) {
    return this.updateVendorService(userId, serviceId, false)
  }

  async adminPublishService(id, serviceId, adminUserId) {
    return this.adminUpdateVendorService(id, serviceId, true, adminUserId)
  }

  async adminUnpublishService(id, serviceId, adminUserId) {
    return this.adminUpdateVendorService(id, serviceId, false, adminUserId)
  }

  // ─── Admin review of vendor-created services ───────────────────────────
  // Uses the `approval_status`/`approved_at`/`approved_by`/`rejection_reason`
  // columns already added to this table by migration 041 for the (separate,
  // opt-in) shop-garment_rates approval workflow — no schema change needed
  // to reuse them here for LNDRY vendor_services review.

  async listServicesForReview({ status, page = 1, limit = 20 } = {}) {
    const conditions = ['vs.deleted_at IS NULL']
    const params = []
    let idx = 1

    if (status) {
      conditions.push(`vs.approval_status = $${idx++}`)
      params.push(status)
    }

    const offset = (page - 1) * limit
    const where = conditions.join(' AND ')

    // Single round trip — subcategory rates are aggregated inline via
    // json_agg rather than fetched per-row (no N+1).
    const { rows } = await query(
      `SELECT vs.id, vs.name, vs.description, vs.approval_status, vs.rejection_reason,
              vs.approved_at, vs.created_at, vs.updated_at,
              v.id AS vendor_id, v.name AS vendor_name,
              sc.id AS category_id, sc.name AS category_name,
              COALESCE(
                json_agg(
                  json_build_object(
                    'rate_id', vsr.id,
                    'garment_type_id', gt.id,
                    'garment_name', gt.name,
                    'unit', gt.unit,
                    'demo_price', gt.cost_price,
                    'rate_paise', vsr.rate_paise,
                    'is_active', vsr.is_active,
                    'override_reason', vsr.override_reason,
                    'override_at', vsr.override_at
                  ) ORDER BY gt.name
                ) FILTER (WHERE vsr.id IS NOT NULL),
                '[]'
              ) AS rates
       FROM vendor_services vs
       JOIN vendors v ON v.id = vs.vendor_id
       LEFT JOIN service_categories sc ON sc.id = vs.category_id
       LEFT JOIN vendor_service_rates vsr ON vsr.vendor_service_id = vs.id
       LEFT JOIN garment_types gt ON gt.id = vsr.garment_type_id
       WHERE ${where}
       GROUP BY vs.id, v.id, sc.id
       ORDER BY vs.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM vendor_services vs WHERE ${where}`,
      params
    )

    return { services: rows, total: countRes.rows[0].total, page, limit }
  }

  async approveVendorServiceAdmin(serviceId, adminUserId) {
    const { rows } = await query(
      `UPDATE vendor_services
       SET approval_status = 'APPROVED', approved_at = NOW(), approved_by = $2, rejection_reason = NULL, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, vendor_id, approval_status, approved_at`,
      [serviceId, adminUserId]
    )
    if (!rows[0]) throw { statusCode: 404, message: 'Vendor service not found' }
    // An approved service can be what makes the vendor service-ready.
    autoPublishAfterChange(rows[0].vendor_id)

    // Approval resolves any earlier price-recalculation note — the price
    // is now signed off, so it shouldn't keep showing as an unresolved flag.
    await query(
      `UPDATE vendor_service_rates SET override_reason = NULL, override_at = NULL
       WHERE vendor_service_id = $1 AND override_reason IS NOT NULL`,
      [serviceId]
    )

    return rows[0]
  }

  async rejectVendorServiceAdmin(serviceId, adminUserId, reason) {
    const { rows } = await query(
      `UPDATE vendor_services
       SET approval_status = 'REJECTED', approved_at = NULL, approved_by = $2, rejection_reason = $3, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, approval_status, rejection_reason`,
      [serviceId, adminUserId, reason]
    )
    if (!rows[0]) throw { statusCode: 404, message: 'Vendor service not found' }
    return rows[0]
  }

  async adminRecalculateServiceRate(rateId, ratePaise, reason) {
    const finalReason = (reason || '').trim() ||
      'Your submitted price for this subcategory didn\'t match our marketplace pricing guidelines, so we\'ve adjusted it.'

    // Single round trip — update + pull everything the notification needs
    // (garment/service name, the vendor's owner user id) via one CTE join,
    // instead of a separate lookup query.
    const { rows } = await query(
      `WITH updated AS (
         UPDATE vendor_service_rates
         SET rate_paise = $2, override_reason = $3, override_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING id, rate_paise, vendor_service_id, garment_type_id, override_reason, override_at
       )
       SELECT u.*, gt.name AS garment_name, vs.name AS service_name, v.created_by AS vendor_user_id
       FROM updated u
       JOIN garment_types gt ON gt.id = u.garment_type_id
       JOIN vendor_services vs ON vs.id = u.vendor_service_id
       JOIN vendors v ON v.id = vs.vendor_id`,
      [rateId, ratePaise, finalReason]
    )
    if (!rows[0]) throw { statusCode: 404, message: 'Rate not found' }
    const result = rows[0]

    if (this.notificationsService && result.vendor_user_id) {
      try {
        await this.notificationsService.sendNotification(result.vendor_user_id, {
          title: 'Price updated by admin',
          body: `${result.garment_name} (${result.service_name}): ₹${(ratePaise / 100).toFixed(2)}. ${finalReason}`,
          type: 'price_override',
          data: {
            vendor_service_id: result.vendor_service_id,
            garment_type_id: result.garment_type_id,
            rate_id: result.id,
            rate_paise: ratePaise,
          },
        })
      } catch (err) {
        logger.error({ err, rateId }, 'Failed to notify vendor of price recalculation')
      }
    }

    return result
  }

  async getCapacity(userId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const { rows: slots } = await query('SELECT id, day_of_week, start_time, end_time, max_orders, is_active FROM vendor_slots WHERE vendor_id = $1', [vendor.id])
    const { rows: exceptions } = await query('SELECT id, date, type, limit_count, reason FROM slot_exceptions WHERE vendor_id = $1', [vendor.id])
    const { rows: pending } = await query(
      `SELECT id, requested_daily_limit, status, created_at FROM capacity_requests
       WHERE vendor_id = $1 AND status = 'PENDING' LIMIT 1`,
      [vendor.id]
    )

    return {
      daily_limit: vendor.operating_hours?.max_orders_per_day || null,
      weekly_availability: slots,
      exceptions,
      pending_capacity_request: pending[0] || null
    }
  }

  // Previously wrote vendor.operating_hours.max_orders_per_day instantly.
  // Now creates/replaces a pending admin-moderated request instead — see
  // capacity_requests (migration 090). A vendor resubmitting while one is
  // already PENDING overwrites it (upsert), backed by a partial unique index
  // on (vendor_id) WHERE status = 'PENDING'.
  async requestCapacityChange(userId, requestedDailyLimit) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const currentLimit = vendor.operating_hours?.max_orders_per_day || null
    const { rows } = await query(
      `INSERT INTO capacity_requests (vendor_id, requested_daily_limit, current_daily_limit_snapshot, status)
       VALUES ($1, $2, $3, 'PENDING')
       ON CONFLICT (vendor_id) WHERE status = 'PENDING'
       DO UPDATE SET requested_daily_limit = $2, current_daily_limit_snapshot = $3, created_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [vendor.id, requestedDailyLimit, currentLimit]
    )
    return rows[0]
  }

  // ─── Admin review of ongoing capacity-change requests ──────────────────

  async adminListCapacityRequests({ status = 'PENDING', page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit
    const { rows } = await query(
      `SELECT cr.*, v.name AS vendor_name, v.branch_code
       FROM capacity_requests cr JOIN vendors v ON v.id = cr.vendor_id
       WHERE cr.status = $1 ORDER BY cr.created_at ASC LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    )
    const countRes = await query(`SELECT COUNT(*)::int AS total FROM capacity_requests WHERE status = $1`, [status])
    return { requests: rows, total: countRes.rows[0].total, page, limit }
  }

  async adminGetVendorCapacity(id) {
    const target = await this._resolveReviewTarget(id)
    if (!target) throw { statusCode: 404, message: 'Vendor or application not found' }

    if (target.kind === 'application') {
      return { stage: 'application', requested_daily_capacity: target.record.requested_daily_capacity }
    }

    const vendor = target.record
    const slots = await this._getPickupSlotsForVendor(vendor.id)
    const { rows: exceptions } = await query('SELECT id, date, type, limit_count, reason FROM slot_exceptions WHERE vendor_id = $1', [vendor.id])
    const { rows: requests } = await query('SELECT * FROM capacity_requests WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 10', [vendor.id])
    return {
      stage: 'vendor',
      daily_limit: vendor.operating_hours?.max_orders_per_day || null,
      weekly_availability: slots,
      exceptions,
      requests
    }
  }

  async adminReviewCapacityRequest(requestId, adminUserId, { status, adminNote }) {
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      throw { statusCode: 400, message: 'Invalid capacity request status' }
    }

    const { rows: existing } = await query('SELECT * FROM capacity_requests WHERE id = $1', [requestId])
    const reqRow = existing[0]
    if (!reqRow) throw { statusCode: 404, message: 'Capacity request not found' }
    if (reqRow.status !== 'PENDING') throw { statusCode: 400, message: 'This request has already been reviewed' }

    let vendorUserId = null
    if (status === 'APPROVED') {
      const vendor = await this.repo.findById(reqRow.vendor_id)
      const operatingHours = vendor.operating_hours || {}
      operatingHours.max_orders_per_day = reqRow.requested_daily_limit
      await this.repo.update(vendor.id, { operating_hours: operatingHours })
      vendorUserId = vendor.created_by
    }

    const { rows: updated } = await query(
      `UPDATE capacity_requests SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status, adminNote || null, adminUserId, requestId]
    )

    if (this.notificationsService) {
      if (!vendorUserId) {
        const vendor = await this.repo.findById(reqRow.vendor_id)
        vendorUserId = vendor?.created_by
      }
      if (vendorUserId) {
        try {
          await this.notificationsService.sendNotification(vendorUserId, {
            title: status === 'APPROVED' ? 'Capacity request approved' : 'Capacity request rejected',
            body: status === 'APPROVED'
              ? `Your daily capacity is now ${reqRow.requested_daily_limit} orders.`
              : (adminNote || 'Your capacity change request was not approved.'),
            type: 'capacity_review',
            data: { capacity_request_id: requestId }
          })
        } catch (err) {
          logger.error({ err, requestId }, 'Failed to notify vendor of capacity review')
        }
      }
    }

    return updated[0]
  }

  // ─── Pickup slots — shared core (vendorId-first), reused by both the
  // vendor's own self-service endpoints and the admin equivalents below.
  // Keeps one implementation instead of forking logic per caller.

  async _getPickupSlotsForVendor(vendorId) {
    const { rows } = await query(
      'SELECT id, day_of_week, start_time, end_time, max_orders, is_active FROM vendor_slots WHERE vendor_id = $1',
      [vendorId]
    )
    return rows
  }

  // vendor_slots.start_time/end_time are plain TIME columns (no date, no
  // wraparound) — a slot straddling midnight isn't representable, so
  // end must simply be later than start within the same day.
  _assertValidTimeRange(start, end) {
    const toMinutes = (t) => {
      const [h, m] = String(t).split(':').map(Number)
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
    }
    const startMin = toMinutes(start)
    const endMin = toMinutes(end)
    if (startMin === null || endMin === null) {
      throw { statusCode: 400, message: 'Invalid slot time format', code: 'INVALID_SLOT_TIME' }
    }
    if (endMin <= startMin) {
      throw { statusCode: 400, message: 'Slot end time must be after start time', code: 'INVALID_SLOT_RANGE' }
    }
  }

  async _createPickupSlotForVendor(vendorId, data) {
    this._assertValidTimeRange(data.start, data.end)
    const { rows } = await query(
      `INSERT INTO vendor_slots (vendor_id, day_of_week, start_time, end_time, max_orders, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, day_of_week, start_time, end_time, max_orders, is_active`,
      [vendorId, data.day_of_week, data.start, data.end, data.max_orders || 5]
    )
    // The first active slot can be what makes a vendor service-ready.
    autoPublishAfterChange(vendorId)
    return rows[0]
  }

  async _updatePickupSlotForVendor(vendorId, slotId, data) {
    const updates = []
    const params = []
    let idx = 1

    if (data.start !== undefined || data.end !== undefined) {
      const { rows: existingRows } = await query(
        'SELECT start_time, end_time FROM vendor_slots WHERE vendor_id = $1 AND id = $2',
        [vendorId, slotId]
      )
      if (existingRows.length === 0) return null
      const nextStart = data.start !== undefined ? data.start : existingRows[0].start_time
      const nextEnd = data.end !== undefined ? data.end : existingRows[0].end_time
      this._assertValidTimeRange(nextStart, nextEnd)
    }

    if (data.max_orders !== undefined) {
      updates.push(`max_orders = $${idx++}`)
      params.push(data.max_orders)
    }

    if (data.is_active !== undefined) {
      updates.push(`is_active = $${idx++}`)
      params.push(data.is_active)
    }

    if (data.start !== undefined) {
      updates.push(`start_time = $${idx++}`)
      params.push(data.start)
    }

    if (data.end !== undefined) {
      updates.push(`end_time = $${idx++}`)
      params.push(data.end)
    }

    if (updates.length === 0) return { success: true }

    params.push(vendorId, slotId)
    const { rows } = await query(
      `UPDATE vendor_slots
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE vendor_id = $${idx} AND id = $${idx + 1}
       RETURNING id, day_of_week, start_time, end_time, max_orders, is_active`,
      params
    )
    if (rows[0]) autoPublishAfterChange(vendorId)
    return rows[0] || null
  }

  async _deletePickupSlotForVendor(vendorId, slotId) {
    await query('DELETE FROM vendor_slots WHERE vendor_id = $1 AND id = $2', [vendorId, slotId])
    return { success: true }
  }

  // ─── Self-service (vendor's own JWT) ────────────────────────────────────

  async getPickupSlots(userId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._getPickupSlotsForVendor(vendor.id)
  }

  async createPickupSlot(userId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._createPickupSlotForVendor(vendor.id, data)
  }

  async updatePickupSlot(userId, slotId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._updatePickupSlotForVendor(vendor.id, slotId, data)
  }

  async deletePickupSlot(userId, slotId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }
    return this._deletePickupSlotForVendor(vendor.id, slotId)
  }

  // ─── Admin (operating on a specific vendor id, must already be approved) ─

  async _requireAdminVendorId(id) {
    const target = await this._resolveReviewTarget(id)
    if (!target || target.kind !== 'vendor') {
      throw { statusCode: 404, message: 'Approved vendor not found' }
    }
    return target.record.id
  }

  async adminGetPickupSlots(id) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._getPickupSlotsForVendor(vendorId)
  }

  async adminCreatePickupSlot(id, data) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._createPickupSlotForVendor(vendorId, data)
  }

  async adminUpdatePickupSlot(id, slotId, data) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._updatePickupSlotForVendor(vendorId, slotId, data)
  }

  async adminDeletePickupSlot(id, slotId) {
    const vendorId = await this._requireAdminVendorId(id)
    return this._deletePickupSlotForVendor(vendorId, slotId)
  }

  // Admin sets the daily capacity directly — unlike a vendor's own request,
  // this doesn't go through capacity_requests approval (the admin IS the
  // approver). Any existing PENDING request for this vendor is superseded
  // (marked APPROVED with a note) so it doesn't linger inconsistently next
  // to a newer, directly-set number.
  async adminSetDailyCapacity(id, maxOrdersPerDay, adminUserId) {
    const vendorId = await this._requireAdminVendorId(id)
    const vendor = await this.repo.findById(vendorId)
    const operatingHours = vendor.operating_hours || {}
    operatingHours.max_orders_per_day = maxOrdersPerDay
    await this.repo.update(vendorId, { operating_hours: operatingHours })

    await query(
      `UPDATE capacity_requests SET status = 'APPROVED', admin_note = 'Set directly by admin', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE vendor_id = $2 AND status = 'PENDING'`,
      [adminUserId, vendorId]
    )

    return { daily_limit: maxOrdersPerDay }
  }

  // Admin-only toggle for whether this vendor offers 60-min express pickup
  // (bypasses the vendor_slots capacity system entirely — see
  // orders.service.js#prepareOrder). No vendor approval needed, same
  // superpower pattern as capacity/slots/services above.
  async adminSetExpressPickupAvailable(id, available) {
    const vendorId = await this._requireAdminVendorId(id)
    const vendor = await this.repo.update(vendorId, { express_pickup_available: available })
    return { express_pickup_available: vendor.express_pickup_available }
  }

  async createCapacityException(userId, data) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const { rows } = await query(
      `INSERT INTO slot_exceptions (vendor_id, date, type, limit_count, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vendor_id, date)
       DO UPDATE SET type = $3, limit_count = $4, reason = $5, created_at = NOW()
       RETURNING id, date, type, limit_count, reason`,
      [vendor.id, data.date, data.type, data.limit || null, data.reason || null]
    )
    return rows[0]
  }

  async deleteCapacityException(userId, exceptionId) {
    const vendor = await this.repo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    await query('DELETE FROM slot_exceptions WHERE vendor_id = $1 AND id = $2', [vendor.id, exceptionId])
    return { success: true }
  }
}


