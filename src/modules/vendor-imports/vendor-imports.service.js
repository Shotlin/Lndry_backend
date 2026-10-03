import { query } from '../../config/database.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorPosCatalogueService, normalizeUnit } from '../vendor-pos-catalogue/vendor-pos-catalogue.service.js'
import { VendorCounterOrdersService } from '../vendor-counter-orders/vendor-counter-orders.service.js'
import { VendorCustomerProfilesService } from '../vendor-customer-profiles/vendor-customer-profiles.service.js'

/**
 * Spreadsheet imports for the counter: customers and the garment price list.
 * The browser reads the file; this validates every row and applies the valid
 * ones through the SAME services the screens use, so an imported row obeys
 * exactly the rules a hand-entered one does (duplicate checks, vendor-private
 * customer details, POS-only catalogue rows).
 */

const MAX_ROWS = 2000
const UNIT_WORDS = new Set(['piece', 'pieces', 'pc', 'pcs', 'item', 'items', 'kg', 'kgs', 'kilogram', 'kilograms', 'pair', 'pairs', 'sqft', 'sq ft', 'sq.ft', 'sq. ft', 'square foot', 'square feet'])
const unitOf = (value) => (/^sq\.?\s*ft$/i.test(clean(value, 30)) ? 'sqft' : normalizeUnit(value))
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const digits = (v) => String(v ?? '').replace(/\D/g, '')
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
const fail = (message, code = 'VALIDATION_ERROR', status = 400) => ({ success: false, message, code, status })

/** A rate typed in a spreadsheet: 40, "40.50", "₹1,200", "Rs. 90". Anything else is NaN (never silently 0). */
export function parseRate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const m = /^\s*(?:₹|rs\.?|inr)?\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*$/i.exec(String(value ?? ''))
  return m ? Number(m[1].replace(/,/g, '')) : NaN
}
const tenDigits = (value) => { const d = digits(value); return d.length >= 10 ? d.slice(-10) : '' }

/** Returns an error sentence for a bad row, or null when it can be imported. */
export function checkRow(type, row) {
  if (type === 'customers') {
    if (!clean(row.name, 100)) return 'Customer name is required'
    if (!tenDigits(row.phone)) return 'Enter a valid 10-digit phone number'
    if (clean(row.email, 160) && !EMAIL.test(clean(row.email, 160))) return 'Enter a valid e-mail address'
    return null
  }
  if (!clean(row.garmentName, 160)) return 'Garment name is required'
  if (!clean(row.serviceName, 160)) return 'Service name is required'
  const rate = parseRate(row.rate)
  if (!Number.isFinite(rate) || rate < 0) return 'Rate must be a number of zero or more'
  if (Math.round(rate * 100) > 2_000_000_000) return 'Rate is too large'
  if (clean(row.unit, 30) && !UNIT_WORDS.has(clean(row.unit, 30).toLowerCase())) return 'Unit must be Piece, Kg, Pair or Sq.Ft'
  const gst = String(row.gstRate ?? '').trim()
  if (gst !== '' && (!Number.isFinite(Number(gst.replace('%', ''))) || Number(gst.replace('%', '')) < 0 || Number(gst.replace('%', '')) > 100)) return 'GST rate must be between 0 and 100'
  if (clean(row.customerPhone, 30) && !tenDigits(row.customerPhone)) return 'Customer phone must be a valid 10-digit number'
  return null
}

export class VendorImportsService {
  constructor() {
    this.catalogue = new VendorPosCatalogueService()
    this.counter = new VendorCounterOrdersService()
    this.profiles = new VendorCustomerProfilesService()
  }

  _rows(input) {
    if (!Array.isArray(input?.rows) || !input.rows.length) return { error: 'Add at least one row to import' }
    if (input.rows.length > MAX_ROWS) return { error: `A maximum of ${MAX_ROWS.toLocaleString('en-IN')} rows can be imported at one time.` }
    return { rows: input.rows.map((r) => (r && typeof r === 'object' ? r : {})) }
  }

  async preview(vendorId, input) {
    const type = input?.type === 'prices' ? 'prices' : input?.type === 'customers' ? 'customers' : null
    if (!type) return fail('Choose what to import')
    const r = this._rows(input); if (r.error) return fail(r.error)
    const errors = []
    const seen = new Set()
    r.rows.forEach((row, i) => {
      const message = checkRow(type, row)
      if (message) return errors.push({ row: i + 2, message })
      const key = type === 'customers'
        ? tenDigits(row.phone)
        : [row.garmentName, row.categoryName, row.serviceName, tenDigits(row.customerPhone)].map((v) => clean(v, 160).toLowerCase()).join('|')
      if (seen.has(key)) return errors.push({ row: i + 2, message: type === 'customers' ? 'This phone number appears more than once in the file' : 'This garment, category and service appears more than once in the file' })
      seen.add(key)
    })
    return { success: true, totalRows: r.rows.length, readyRows: r.rows.length - errors.length, errors }
  }

  async listJobs(vendorId, type) {
    const t = type === 'prices' ? 'prices' : 'customers'
    const { rows } = await query(
      `SELECT * FROM vendor_import_jobs WHERE vendor_id = $1 AND import_type = $2 ORDER BY completed_at DESC LIMIT 20`, [vendorId, t])
    return rows.map((j) => ({
      id: j.id, importType: j.import_type, status: j.status, totalRows: j.total_rows, createdRows: j.created_rows, updatedRows: j.updated_rows,
      skippedRows: j.skipped_rows, errors: j.errors, completedAt: j.completed_at, actor: j.actor_name || '',
    }))
  }

  async commit(vendorId, actor, type, input) {
    const r = this._rows(input); if (r.error) return fail(r.error)
    let created = 0; let updated = 0
    const errors = []
    const seen = new Set()
    for (let i = 0; i < r.rows.length; i += 1) {
      const row = r.rows[i]
      const rowNo = i + 2
      const message = checkRow(type, row)
      if (message) { errors.push({ row: rowNo, message }); continue }
      try {
        const outcome = type === 'customers' ? await this._customer(vendorId, actor, row, seen) : await this._price(vendorId, actor, row, seen)
        if (outcome.error) errors.push({ row: rowNo, message: outcome.error })
        else if (outcome.created) created += 1
        else updated += 1
      } catch (err) {
        errors.push({ row: rowNo, message: 'This row could not be saved' })
      }
    }
    const skipped = errors.length
    const job = (await query(
      `INSERT INTO vendor_import_jobs (vendor_id, import_type, status, total_rows, created_rows, updated_rows, skipped_rows, errors, actor_user_id, actor_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,(SELECT name FROM users WHERE id = $9)) RETURNING id, status`,
      [vendorId, type, skipped && !created && !updated ? 'FAILED' : 'COMPLETED', r.rows.length, created, updated, skipped, JSON.stringify(errors.slice(0, 200)), actor.userId]
    )).rows[0]
    emitAudit('vendor_import_completed', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor', target_id: vendorId,
      before: null, after: { type, total: r.rows.length, created, updated, skipped }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, created, updated, skipped, errors, job }
  }

  async _customer(vendorId, actor, row, seen) {
    const phone = tenDigits(row.phone)
    if (seen.has(phone)) return { error: 'This phone number appears more than once in the file' }
    seen.add(phone)
    const found = await this.counter.findOrCreateCustomer(vendorId, actor, { name: clean(row.name, 100), phone })
    if (!found.success) return { error: found.message }
    const id = found.customer.id
    await this.profiles.ensureProfile(vendorId, id, clean(row.name, 100))
    const email = clean(row.email, 160).toLowerCase()
    const patch = { name: clean(row.name, 100) }
    if (email) patch.email = email
    await this.profiles.update(vendorId, actor, id, patch)
    const address = clean(row.address, 255)
    if (address) {
      const existing = await this.profiles.listAddresses(vendorId, id)
      if (!existing.addresses.some((a) => a.addressLine1.toLowerCase() === address.toLowerCase())) {
        await this.profiles.createAddress(vendorId, actor, id, { label: 'Home', addressLine1: address })
      }
    }
    return { created: found.created === true }
  }

  async _price(vendorId, actor, row, seen) {
    const garmentName = clean(row.garmentName, 160); const serviceName = clean(row.serviceName, 160); const categoryName = clean(row.categoryName, 120)
    const phone = tenDigits(row.customerPhone)
    const key = [garmentName, categoryName, serviceName, phone].map((v) => v.toLowerCase()).join('|')
    if (seen.has(key)) return { error: 'This garment, category and service appears more than once in the file' }
    seen.add(key)

    let customerId = null
    if (phone) {
      const u = (await query('SELECT id FROM users WHERE phone = $1 OR phone = $2 OR phone = $3 LIMIT 1', [phone, `+91${phone}`, `91${phone}`])).rows[0]
      if (!u) return { error: 'No customer with this phone number. Add the customer first.' }
      customerId = u.id
    }

    let categoryId = null
    if (categoryName) {
      const found = (await query('SELECT id FROM pos_categories WHERE vendor_id = $1 AND lower(name) = lower($2) AND parent_id IS NULL LIMIT 1', [vendorId, categoryName])).rows[0]
        || (await query('SELECT id FROM pos_categories WHERE vendor_id = $1 AND lower(name) = lower($2) LIMIT 1', [vendorId, categoryName])).rows[0]
      if (found) categoryId = found.id
      else {
        const made = await this.catalogue.createCategory(vendorId, actor, { name: categoryName })
        if (!made.success) return { error: made.message }
        categoryId = made.category.id
      }
    }

    const wantedUnit = clean(row.unit, 30) ? unitOf(row.unit) : null
    let garment = (await query('SELECT id FROM pos_garments WHERE vendor_id = $1 AND lower(name) = lower($2) AND category_id IS NOT DISTINCT FROM $3 LIMIT 1', [vendorId, garmentName, categoryId])).rows[0]
    const hsn = clean(row.hsn, 20)
    const gstText = String(row.gstRate ?? '').replace('%', '').trim()
    if (!garment) {
      const made = await this.catalogue.createGarment(vendorId, actor, { name: garmentName, categoryId, unit: wantedUnit || 'piece', hsn: hsn || undefined, gstRate: gstText === '' ? undefined : Number(gstText) })
      if (!made.success) return { error: made.message }
      garment = { id: made.garment.id }
    }

    let service = (await query('SELECT id FROM pos_services WHERE vendor_id = $1 AND lower(name) = lower($2) LIMIT 1', [vendorId, serviceName])).rows[0]
    if (!service) {
      const made = await this.catalogue.createService(vendorId, actor, { name: serviceName })
      if (!made.success) return { error: made.message }
      service = { id: made.service.id }
    }

    const ratePaise = Math.round(parseRate(row.rate) * 100)
    const existing = (await query(
      'SELECT id FROM pos_prices WHERE vendor_id = $1 AND garment_id = $2 AND service_id = $3 AND customer_user_id IS NOT DISTINCT FROM $4 LIMIT 1',
      [vendorId, garment.id, service.id, customerId])).rows[0]
    if (existing) {
      const done = await this.catalogue.updatePrice(vendorId, actor, existing.id, { ratePaise })
      return done.success ? { created: false } : { error: done.message }
    }
    const done = await this.catalogue.createPrice(vendorId, actor, { garmentId: garment.id, serviceId: service.id, customerUserId: customerId, ratePaise })
    return done.success ? { created: true } : { error: done.message }
  }
}
