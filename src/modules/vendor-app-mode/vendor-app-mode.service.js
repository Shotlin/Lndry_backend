import slugify from 'slugify'
import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { cacheDel } from '../../utils/cache.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { loadVendorActor } from '../../middlewares/vendor-permission.js'
import { capabilitiesFor, normalizeVendorType } from '../vendors/vendor-tier.js'
import { VendorPosCatalogueService } from '../vendor-pos-catalogue/vendor-pos-catalogue.service.js'
import { allowedModesFor } from './offering.js'
import { STARTER_CATEGORIES, STARTER_SERVICES } from './starter-pricelist.js'

/**
 * POS onboarding + "which modes may this vendor use" for the Vendor App.
 *
 * The backend decides what a vendor is ENTITLED to (vendors.offering); the app
 * decides which of those modes the person is currently USING. Nothing here
 * touches the marketplace application flow.
 */

export const offeringCacheKey = (vendorId) => `lndry:offering:v1:${vendorId}`

const ONBOARDING_STEPS = ['shop', 'tax', 'counter', 'pricelist']
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const UPI = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/
const PREFIX = /^[A-Z0-9]{1,6}$/
const PINCODE = /^\d{6}$/
const PRINTER_PROFILES = ['none', 'system-default', 'thermal-58mm', 'thermal-80mm']

const fail = (message, code = 'VALIDATION_ERROR', status = 400, extra = {}) => ({ success: false, message, code, status, ...extra })
const text = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '')

/** One validator per wizard step. Returns { value } (clean) or { error }. */
export const STEP_VALIDATORS = {
  shop(input) {
    const name = text(input.name)
    const ownerName = text(input.ownerName)
    const addressLine1 = text(input.addressLine1)
    const city = text(input.city)
    const state = text(input.state)
    const pincode = text(input.pincode)
    if (name.length < 2 || name.length > 200) return { error: 'Enter your shop name (2 to 200 letters).' }
    if (ownerName.length < 2 || ownerName.length > 120) return { error: 'Enter the owner name.' }
    if (addressLine1.length < 3 || addressLine1.length > 255) return { error: 'Enter your shop address.' }
    if (city.length < 2 || city.length > 100) return { error: 'Enter your city.' }
    if (state.length > 100) return { error: 'State is too long.' }
    if (pincode && !PINCODE.test(pincode)) return { error: 'Pincode must be 6 digits.' }
    return { value: { name, ownerName, addressLine1, city, state: state || null, pincode: pincode || null } }
  },

  tax(input) {
    const gstEnabled = input.gstEnabled === true
    const gstin = text(input.gstin).toUpperCase()
    const upiId = text(input.upiId)
    const currency = text(input.currency).toUpperCase() || 'INR'
    const invoicePrefix = text(input.invoicePrefix).toUpperCase() || 'INV'
    if (gstEnabled && !GSTIN.test(gstin)) return { error: 'Enter a valid 15-character GSTIN, or turn GST off.' }
    if (upiId && !UPI.test(upiId)) return { error: 'UPI ID looks wrong. It should look like name@bank.' }
    if (currency !== 'INR') return { error: 'Only Indian Rupees (INR) is supported right now.' }
    if (!PREFIX.test(invoicePrefix)) return { error: 'Invoice prefix can be 1 to 6 letters or numbers.' }
    return { value: { gstEnabled, gstin: gstEnabled ? gstin : null, upiId: upiId || null, currency, invoicePrefix } }
  },

  counter(input) {
    const printerProfile = text(input.printerProfile) || 'none'
    const orderSeriesPrefix = text(input.orderSeriesPrefix).toUpperCase() || 'LN'
    const days = input.defaultDeliveryDays === undefined ? 3 : Number(input.defaultDeliveryDays)
    if (!PRINTER_PROFILES.includes(printerProfile)) return { error: 'Choose a printer option from the list.' }
    if (!PREFIX.test(orderSeriesPrefix)) return { error: 'Order number prefix can be 1 to 6 letters or numbers.' }
    if (!Number.isInteger(days) || days < 0 || days > 30) return { error: 'Delivery days must be between 0 and 30.' }
    return { value: { printerProfile, orderSeriesPrefix, defaultDeliveryDays: days } }
  },

  pricelist(input) {
    const choice = text(input.choice).toLowerCase()
    if (!['starter', 'own'].includes(choice)) return { error: 'Choose the starter price list or add your own.' }
    return { value: { choice } }
  },
}

const shapeVendor = (row) => {
  const offering = row.offering
  const status = row.pos_onboarding_status
  const type = normalizeVendorType(row.vendor_type) || 'STANDARD'
  return {
    hasVendor: true,
    vendorId: row.id,
    shopName: row.name,
    offering,
    posOnboardingStatus: status,
    posPlanName: row.pos_plan_name ?? null,
    posValidTo: row.pos_valid_to ? String(row.pos_valid_to instanceof Date ? row.pos_valid_to.toISOString() : row.pos_valid_to).slice(0, 10) : null,
    allowedModes: allowedModesFor(offering, status),
    needsPosOnboarding: offering !== 'MARKETPLACE' && status !== 'COMPLETED',
    canStartPos: offering === 'MARKETPLACE',
    ...capabilitiesFor(type),
  }
}

const VENDOR_COLUMNS = `id, name, offering, pos_onboarding_status, pos_plan_name, pos_valid_to, pos_onboarding_data, vendor_type`

export class VendorAppModeService {
  constructor({ catalogue = new VendorPosCatalogueService() } = {}) {
    this.catalogue = catalogue
  }

  async _vendorRow(vendorId, client = null) {
    const run = client ? client.query.bind(client) : query
    const { rows } = await run(`SELECT ${VENDOR_COLUMNS} FROM vendors WHERE id = $1 AND deleted_at IS NULL`, [vendorId])
    return rows[0] || null
  }

  _invalidate(vendorId) {
    return cacheDel(offeringCacheKey(vendorId)).catch((err) => logger.warn({ err: err.message, vendorId }, 'Offering cache invalidation failed'))
  }

  /** GET /vendor/app-mode — for any signed-in user, including one with no vendor yet. */
  async getAppMode(user) {
    const actor = await loadVendorActor(user.id, user.shopId || user.vendor_id || null)
    if (!actor) return { success: true, appMode: { hasVendor: false, vendorId: null, offering: null, posOnboardingStatus: 'NOT_STARTED', allowedModes: [], needsPosOnboarding: false, canStartPos: true, role: null } }
    const row = await this._vendorRow(actor.vendorId)
    if (!row) return fail('Vendor not found', 'NOT_FOUND', 404)
    return { success: true, appMode: { ...shapeVendor(row), role: actor.role } }
  }

  /** The saved wizard answers, so the app can resume where the owner stopped. */
  async getOnboarding(vendorId) {
    const row = await this._vendorRow(vendorId)
    if (!row) return fail('Vendor not found', 'NOT_FOUND', 404)
    const data = row.pos_onboarding_data || {}
    const missing = ONBOARDING_STEPS.filter((step) => !data[step])
    return { success: true, onboarding: { status: row.pos_onboarding_status, offering: row.offering, data, missingSteps: missing, nextStep: missing[0] ?? null } }
  }

  /**
   * POST /vendor/pos-onboarding/start — idempotent.
   *  - existing marketplace owner  → offering becomes BOTH, onboarding IN_PROGRESS
   *  - brand-new user (no vendor)  → a POS-only vendor is created (not listed, no KYC)
   */
  async start(user, meta = {}) {
    const actor = await loadVendorActor(user.id, user.shopId || user.vendor_id || null)
    if (actor) {
      if (actor.role !== 'VENDOR_OWNER') return fail('Only the shop owner can set up POS.', 'NOT_OWNER', 403)
      return this._startForExisting(actor.vendorId, user, meta)
    }
    return this._createPosVendor(user, meta)
  }

  async _startForExisting(vendorId, user, meta) {
    const before = await this._vendorRow(vendorId)
    if (!before) return fail('Vendor not found', 'NOT_FOUND', 404)
    const nextOffering = before.offering === 'MARKETPLACE' ? 'BOTH' : before.offering
    const nextStatus = before.pos_onboarding_status === 'NOT_STARTED' ? 'IN_PROGRESS' : before.pos_onboarding_status
    if (nextOffering !== before.offering || nextStatus !== before.pos_onboarding_status) {
      await query(`UPDATE vendors SET offering = $2, pos_onboarding_status = $3, updated_at = NOW() WHERE id = $1`, [vendorId, nextOffering, nextStatus])
      await this._invalidate(vendorId)
      emitAudit('vendor_offering_changed', {
        actor_user_id: user.id, actor_role: 'VENDOR_OWNER', target_type: 'vendor', target_id: vendorId,
        before: { offering: before.offering, pos_onboarding_status: before.pos_onboarding_status },
        after: { offering: nextOffering, pos_onboarding_status: nextStatus },
        ip_address: meta.ip ?? null, user_agent: meta.userAgent ?? null,
      })
    }
    const res = await this.getAppMode(user)
    return { ...res, created: false, needsTokenRefresh: false }
  }

  async _createPosVendor(user, meta) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Two quick taps (or two devices) must not create two shops for one person.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pos-start:${user.id}`])

      const existing = await client.query(
        `SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL LIMIT 1`, [user.id])
      if (existing.rows[0]) {
        await client.query('COMMIT')
        const res = await this.getAppMode(user)
        return { ...res, created: false, needsTokenRefresh: true }
      }
      const application = await client.query(`SELECT 1 FROM vendor_applications WHERE owner_id = $1 LIMIT 1`, [user.id])
      if (application.rows[0]) {
        await client.query('ROLLBACK')
        return fail('You already have a marketplace application. Please contact LNDRY support to add POS to it.', 'MARKETPLACE_APPLICATION_EXISTS', 409)
      }

      const profile = (await client.query('SELECT name, phone FROM users WHERE id = $1', [user.id])).rows[0] || {}
      const baseName = text(profile.name) || 'My Shop'
      let vendor = null
      for (let attempt = 0; attempt < 5 && !vendor; attempt += 1) {
        const suffix = Math.random().toString(36).substring(2, 8)
        const slug = `${slugify(baseName, { lower: true, strict: true }) || 'shop'}-${suffix}`
        const branchCode = `POS-${suffix.toUpperCase()}`
        try {
          await client.query('SAVEPOINT create_vendor')
          // Placeholders satisfy the NOT NULL address columns; step 1 of onboarding replaces them.
          // vendor_approved / marketplace_published stay false → never listed, never auto-published.
          vendor = (await client.query(
            `INSERT INTO vendors (name, slug, branch_code, phone, address_line1, city, state, pincode, lat, lng,
                                  created_by, status, vendor_approved, account_enabled, marketplace_published,
                                  vendor_type, offering, pos_onboarding_status)
             VALUES ($1, $2, $3, $4, 'Not set yet', 'Not set yet', 'Not set yet', '000000', 0, 0,
                     $5, 'APPROVED', false, true, false, 'STANDARD', 'POS', 'IN_PROGRESS')
             RETURNING id`,
            [baseName, slug, branchCode, profile.phone ?? null, user.id])).rows[0]
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT create_vendor')
          if (err.code !== '23505') throw err // slug / branch code clash → try another suffix
        }
      }
      if (!vendor) throw new Error('Could not allocate a unique shop code')

      await client.query(
        `INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1, $2, 'VENDOR_OWNER', true)`, [vendor.id, user.id])
      await client.query('COMMIT')

      emitAudit('vendor_pos_created', {
        actor_user_id: user.id, actor_role: 'VENDOR_OWNER', target_type: 'vendor', target_id: vendor.id,
        before: null, after: { offering: 'POS', vendor_type: 'STANDARD' },
        ip_address: meta.ip ?? null, user_agent: meta.userAgent ?? null,
      })
      logger.info({ vendorId: vendor.id, userId: user.id }, 'POS-only vendor created')
      const res = await this.getAppMode(user)
      return { ...res, created: true, needsTokenRefresh: true }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** PATCH /vendor/pos-onboarding — save one wizard step. */
  async saveStep(vendorId, actor, step, input) {
    const validate = STEP_VALIDATORS[step]
    if (!validate) return fail(`Unknown step. Use one of: ${ONBOARDING_STEPS.join(', ')}`, 'UNKNOWN_STEP')
    const row = await this._vendorRow(vendorId)
    if (!row) return fail('Vendor not found', 'NOT_FOUND', 404)
    if (row.offering === 'MARKETPLACE') return fail('POS setup has not been started for this shop.', 'POS_NOT_STARTED', 409)

    const checked = validate(input && typeof input === 'object' ? input : {})
    if (checked.error) return fail(checked.error)

    const status = row.pos_onboarding_status === 'NOT_STARTED' ? 'IN_PROGRESS' : row.pos_onboarding_status
    const data = { ...(row.pos_onboarding_data || {}), [step]: checked.value }

    // Real profile columns are kept in sync so invoices and the admin dashboard see them.
    // A COMPLETED shop editing step 1 must not blank anything: only provided values are written.
    if (step === 'shop') {
      const v = checked.value
      await query(
        `UPDATE vendors SET name = $2, owner_name = $3, address_line1 = $4, city = $5,
                state = COALESCE($6, state), pincode = COALESCE($7, pincode),
                pos_onboarding_data = $8::jsonb, pos_onboarding_status = $9, updated_at = NOW()
          WHERE id = $1`,
        [vendorId, v.name, v.ownerName, v.addressLine1, v.city, v.state, v.pincode, JSON.stringify(data), status])
    } else if (step === 'tax') {
      await query(
        `UPDATE vendors SET gst_number = $2, pos_onboarding_data = $3::jsonb, pos_onboarding_status = $4, updated_at = NOW() WHERE id = $1`,
        [vendorId, checked.value.gstin, JSON.stringify(data), status])
    } else {
      await query(
        `UPDATE vendors SET pos_onboarding_data = $2::jsonb, pos_onboarding_status = $3, updated_at = NOW() WHERE id = $1`,
        [vendorId, JSON.stringify(data), status])
    }
    await this._invalidate(vendorId)
    return this.getOnboarding(vendorId)
  }

  /** POST /vendor/pos-onboarding/complete */
  async complete(vendorId, actor) {
    const row = await this._vendorRow(vendorId)
    if (!row) return fail('Vendor not found', 'NOT_FOUND', 404)
    if (row.offering === 'MARKETPLACE') return fail('POS setup has not been started for this shop.', 'POS_NOT_STARTED', 409)
    const data = row.pos_onboarding_data || {}
    const missing = ONBOARDING_STEPS.filter((step) => !data[step])
    if (missing.length) return fail(`Please finish these steps first: ${missing.join(', ')}.`, 'ONBOARDING_INCOMPLETE', 400, { missingSteps: missing })

    let starter = null
    if (data.pricelist.choice === 'starter' && !data.starterApplied) {
      try {
        starter = await this._applyStarterPricelist(vendorId, actor)
      } catch (err) {
        // Re-running complete() is safe (duplicates are skipped), so the owner can simply retry.
        logger.error({ err: err.message, vendorId }, 'Starter price list failed')
        return fail('We could not add the starter price list. Please try again.', 'STARTER_PRICELIST_FAILED', 500)
      }
      data.starterApplied = true
    }

    await query(`UPDATE vendors SET pos_onboarding_status = 'COMPLETED', pos_onboarding_data = $2::jsonb, updated_at = NOW() WHERE id = $1`, [vendorId, JSON.stringify(data)])
    await this._invalidate(vendorId)
    if (row.pos_onboarding_status !== 'COMPLETED') {
      emitAudit('vendor_pos_onboarding_completed', {
        actor_user_id: actor.userId ?? null, actor_role: actor.role ?? 'VENDOR_OWNER', target_type: 'vendor', target_id: vendorId,
        before: { pos_onboarding_status: row.pos_onboarding_status }, after: { pos_onboarding_status: 'COMPLETED', starter },
        ip_address: actor.ip ?? null, user_agent: actor.userAgent ?? null,
      })
    }
    const after = await this._vendorRow(vendorId)
    return { success: true, appMode: { ...shapeVendor(after), role: 'VENDOR_OWNER' }, starterPricelist: starter }
  }

  /**
   * Creates the sample categories / services / garments / prices through the normal catalogue
   * service (same validation and audit as an owner doing it by hand). Safe to re-run: a duplicate
   * (409) just means it is already there.
   */
  async _applyStarterPricelist(vendorId, actor) {
    const counts = { categories: 0, services: 0, garments: 0, prices: 0 }
    const serviceIds = {}
    for (const service of STARTER_SERVICES) {
      const res = await this.catalogue.createService(vendorId, actor, { name: service.name })
      if (res.success) { serviceIds[service.key] = res.service.id; counts.services += 1 }
      else if (res.code === 'DUPLICATE_NAME') {
        const found = (await query(`SELECT id FROM pos_services WHERE vendor_id = $1 AND lower(name) = lower($2)`, [vendorId, service.name])).rows[0]
        if (found) serviceIds[service.key] = found.id
      } else throw new Error(`Starter price list failed at service "${service.name}": ${res.message}`)
    }
    for (const [order, category] of STARTER_CATEGORIES.entries()) {
      let categoryId
      const created = await this.catalogue.createCategory(vendorId, actor, { name: category.name, sortOrder: order })
      if (created.success) { categoryId = created.category.id; counts.categories += 1 }
      else if (created.code === 'DUPLICATE_NAME') {
        categoryId = (await query(`SELECT id FROM pos_categories WHERE vendor_id = $1 AND lower(name) = lower($2) AND parent_id IS NULL`, [vendorId, category.name])).rows[0]?.id
      } else throw new Error(`Starter price list failed at category "${category.name}": ${created.message}`)

      for (const garment of category.garments) {
        let garmentId
        const g = await this.catalogue.createGarment(vendorId, actor, { name: garment.name, categoryId, unit: 'piece' })
        if (g.success) { garmentId = g.garment.id; counts.garments += 1 }
        else if (g.code === 'DUPLICATE_NAME') {
          garmentId = (await query(`SELECT id FROM pos_garments WHERE vendor_id = $1 AND lower(name) = lower($2) AND category_id IS NOT DISTINCT FROM $3`, [vendorId, garment.name, categoryId])).rows[0]?.id
        } else throw new Error(`Starter price list failed at garment "${garment.name}": ${g.message}`)
        if (!garmentId) continue
        for (const [serviceKey, ratePaise] of Object.entries(garment.rates)) {
          if (!serviceIds[serviceKey]) continue
          const p = await this.catalogue.createPrice(vendorId, actor, { garmentId, serviceId: serviceIds[serviceKey], ratePaise })
          if (p.success) counts.prices += 1
          else if (p.code !== 'DUPLICATE_PRICE') throw new Error(`Starter price list failed at a price for "${garment.name}": ${p.message}`)
        }
      }
    }
    return counts
  }
}
