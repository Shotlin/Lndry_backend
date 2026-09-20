import { createHash } from 'node:crypto'
import { query, getClient } from '../../config/database.js'
import { emit as emitAudit } from '../../utils/audit-log.js'

/**
 * POS catalogue — the in-store counter's own, vendor-scoped catalogue.
 *
 * It is deliberately separate from the marketplace catalogue (service_categories,
 * garment_types, vendor_services, vendor_service_rates):
 *   - it is only ever READ from the marketplace tables (to import/refresh the
 *     vendor's own approved services) and never writes to them;
 *   - POS-only categories / sub-categories / services / garments / prices need
 *     no approval and are never visible to the customer app or other vendors;
 *   - a POS price the vendor changed (price_overridden) is never overwritten by
 *     a later sync — only the reference marketplace price is refreshed.
 *
 * Every query below is scoped by vendor_id.
 */

const UNITS = { piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', item: 'piece', items: 'piece', kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', pair: 'pair', pairs: 'pair', sqft: 'sqft', 'square foot': 'sqft', 'square feet': 'sqft' }
const UNIT_LABEL = { piece: 'Piece', kg: 'Kilogram', pair: 'Pair', sqft: 'Square Foot' }
export const normalizeUnit = (value) => UNITS[String(value ?? '').trim().toLowerCase()] || 'piece'
export const unitLabel = (unit) => UNIT_LABEL[normalizeUnit(unit)]
// Images are kept inline in the catalogue payload, so they are capped small (the counter screen shrinks photos before sending).
const MAX_IMAGE_CHARS = 600_000

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ''))
const fail = (message, code = 'VALIDATION_ERROR', status = 400) => ({ success: false, message, code, status })

const cleanName = (value, label, max) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return { error: `${label} is required` }
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer` }
  return { value: text }
}

/** Accepts an https/http link, a bundled asset path, or a small pasted/uploaded image. */
function cleanImage(value) {
  if (value === undefined) return { skip: true }
  if (value === null || value === '') return { value: null }
  const text = String(value).trim()
  if (text.length > MAX_IMAGE_CHARS) return { error: 'That image is too large. Use an image under 400 KB.' }
  if (/^https?:\/\//i.test(text) || /^\/[\w./%-]+$/.test(text) || /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(text)) return { value: text }
  return { error: 'The image must be a PNG, JPEG or WebP file, or a web link.' }
}

const cat = (r) => ({ id: r.id, parentId: r.parent_id, name: r.name, color: r.color, imageUrl: r.image_url, sortOrder: r.sort_order, active: r.active, source: r.source, locallyEdited: r.locally_edited, marketplaceMissing: r.marketplace_missing })
const svc = (r) => ({ id: r.id, name: r.name, description: r.description || '', imageUrl: r.image_url, units: r.units || [], active: r.active, source: r.source, locallyEdited: r.locally_edited, marketplaceMissing: r.marketplace_missing })
const gar = (r) => ({ id: r.id, categoryId: r.category_id, name: r.name, code: r.code || '', unit: r.unit, imageUrl: r.image_url, hsn: r.hsn || '', gstRate: Number(r.gst_rate), active: r.active, source: r.source, locallyEdited: r.locally_edited, marketplaceMissing: r.marketplace_missing })
const prc = (r) => ({
  id: r.id, garmentId: r.garment_id, serviceId: r.service_id, customerUserId: r.customer_user_id, ratePaise: r.rate_paise, active: r.active, source: r.source,
  marketplaceRatePaise: r.marketplace_rate_paise, priceOverridden: r.price_overridden, marketplaceMissing: r.marketplace_missing,
})
const tax = (r) => ({ id: r.id, name: r.name, rateBps: r.rate_bps, active: r.active })

export class VendorPosCatalogueService {
  // ── Reading ────────────────────────────────────────────────────────────

  async getCatalogue(vendorId) {
    const sync = await this.ensureFresh(vendorId)
    const [c, s, g, p, t, st] = await Promise.all([
      query('SELECT * FROM pos_categories WHERE vendor_id = $1 ORDER BY sort_order, lower(name)', [vendorId]),
      query('SELECT * FROM pos_services WHERE vendor_id = $1 ORDER BY lower(name)', [vendorId]),
      query('SELECT * FROM pos_garments WHERE vendor_id = $1 ORDER BY lower(name)', [vendorId]),
      query('SELECT * FROM pos_prices WHERE vendor_id = $1 ORDER BY created_at', [vendorId]),
      query('SELECT * FROM pos_tax_rules WHERE vendor_id = $1 ORDER BY lower(name)', [vendorId]),
      query('SELECT last_synced_at FROM pos_catalogue_state WHERE vendor_id = $1', [vendorId]),
    ])
    return {
      categories: c.rows.map(cat), services: s.rows.map(svc), garments: g.rows.map(gar), prices: p.rows.map(prc), taxRules: t.rows.map(tax),
      lastSyncedAt: st.rows[0]?.last_synced_at || null, sync,
    }
  }

  /** Marketplace-linked prices, keyed by their marketplace rate id (used by service packages). */
  async listMarketplaceLinkedRates(vendorId) {
    await this.ensureFresh(vendorId)
    const { rows } = await query(
      `SELECT p.marketplace_rate_id AS id, p.garment_id, p.service_id FROM pos_prices p
       WHERE p.vendor_id = $1 AND p.marketplace_rate_id IS NOT NULL AND p.active AND p.customer_user_id IS NULL`, [vendorId])
    return rows.map((r) => ({ id: r.id, garmentTypeId: r.garment_id, vendorServiceId: r.service_id }))
  }

  // ── Marketplace → POS sync (read-only on the marketplace side) ─────────

  /** The vendor's own approved, active marketplace services and prices — read only. */
  async _fetchFeed(runner, vendorId) {
    const { rows } = await runner.query(
      `SELECT vsr.id AS rate_id, vsr.garment_type_id, gt.name AS garment_name, gt.unit, vsr.rate_paise,
              vs.id AS service_id, vs.name AS service_name, vs.description AS service_description, vs.image_asset_id AS service_image,
              sc.id AS category_id, sc.name AS category_name, sc.image_url AS category_image, sc.sort_order AS category_sort,
              gt.images->>0 AS garment_image_url
       FROM vendor_service_rates vsr
       JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
       JOIN garment_types gt ON vsr.garment_type_id = gt.id
       LEFT JOIN service_categories sc ON gt.category_id = sc.id
       WHERE vs.vendor_id = $1 AND vsr.is_active = true AND vs.is_available = true
         AND vs.deleted_at IS NULL AND vs.approval_status = 'APPROVED' AND gt.is_active = true
       ORDER BY sc.name, vs.name, gt.name, vsr.id`, [vendorId])
    return rows
  }

  _feedHash(rows) {
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  }

  /** First visit imports the vendor's existing services; afterwards re-syncs only when the vendor's marketplace services changed. */
  async ensureFresh(vendorId, { maxAgeMs = 0 } = {}) {
    // Frequent callers (every quote) may accept a check made a few seconds ago.
    this._checked ||= new Map()
    if (maxAgeMs && Date.now() - (this._checked.get(vendorId) || 0) < maxAgeMs) return null
    const state = (await query('SELECT feed_hash FROM pos_catalogue_state WHERE vendor_id = $1', [vendorId])).rows[0]
    this._checked.set(vendorId, Date.now())
    if (!state) return this.sync(vendorId, { initial: true })
    // Anything that changed on the vendor's LNDRY side (a price, a new/removed service, a rename, a photo) changes the hash.
    const hash = this._feedHash(await this._fetchFeed({ query }, vendorId))
    return hash === state.feed_hash ? null : this.sync(vendorId, { initial: false })
  }

  async sync(vendorId, { initial = false } = {}) {
    const client = await getClient()
    const summary = { initial, categories: 0, services: 0, garments: 0, prices: 0, priceChangesKept: 0, removed: 0 }
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pos-catalogue-sync:${vendorId}`])

      const rows = await this._fetchFeed(client, vendorId)

      // Categories
      const catMap = new Map()
      for (const row of rows) {
        if (!row.category_id || catMap.has(row.category_id)) continue
        const r = await client.query(
          `INSERT INTO pos_categories (vendor_id, name, image_url, sort_order, source, marketplace_category_id)
           VALUES ($1, $2, $3, $4, 'MARKETPLACE', $5)
           ON CONFLICT (vendor_id, marketplace_category_id) WHERE marketplace_category_id IS NOT NULL DO UPDATE SET
             name = CASE WHEN pos_categories.locally_edited THEN pos_categories.name ELSE EXCLUDED.name END,
             image_url = CASE WHEN pos_categories.locally_edited THEN pos_categories.image_url ELSE EXCLUDED.image_url END,
             sort_order = EXCLUDED.sort_order,
             active = CASE WHEN pos_categories.marketplace_missing AND NOT pos_categories.locally_edited THEN true ELSE pos_categories.active END,
             marketplace_missing = false, updated_at = NOW()
           RETURNING id`, [vendorId, row.category_name, row.category_image, row.category_sort ?? 0, row.category_id])
        catMap.set(row.category_id, r.rows[0].id)
      }
      summary.categories = catMap.size

      // Services (units = the units of the garments they price)
      const unitsByService = new Map()
      for (const row of rows) {
        const set = unitsByService.get(row.service_id) || new Set()
        set.add(unitLabel(row.unit)); unitsByService.set(row.service_id, set)
      }
      const svcMap = new Map()
      for (const row of rows) {
        if (svcMap.has(row.service_id)) continue
        const r = await client.query(
          `INSERT INTO pos_services (vendor_id, name, description, image_url, units, source, marketplace_service_id)
           VALUES ($1, $2, $3, $4, $5, 'MARKETPLACE', $6)
           ON CONFLICT (vendor_id, marketplace_service_id) WHERE marketplace_service_id IS NOT NULL DO UPDATE SET
             name = CASE WHEN pos_services.locally_edited THEN pos_services.name ELSE EXCLUDED.name END,
             description = CASE WHEN pos_services.locally_edited THEN pos_services.description ELSE EXCLUDED.description END,
             image_url = CASE WHEN pos_services.locally_edited THEN pos_services.image_url ELSE EXCLUDED.image_url END,
             units = CASE WHEN pos_services.locally_edited THEN pos_services.units ELSE EXCLUDED.units END,
             active = CASE WHEN pos_services.marketplace_missing AND NOT pos_services.locally_edited THEN true ELSE pos_services.active END,
             marketplace_missing = false, updated_at = NOW()
           RETURNING id`, [vendorId, row.service_name, row.service_description || null, row.service_image || null, [...unitsByService.get(row.service_id)], row.service_id])
        svcMap.set(row.service_id, r.rows[0].id)
      }
      summary.services = svcMap.size

      // Garments
      const garMap = new Map()
      for (const row of rows) {
        if (garMap.has(row.garment_type_id)) continue
        const image = row.garment_image_url || row.service_image || row.category_image || null
        const r = await client.query(
          `INSERT INTO pos_garments (vendor_id, category_id, name, unit, image_url, source, marketplace_garment_type_id)
           VALUES ($1, $2, $3, $4, $5, 'MARKETPLACE', $6)
           ON CONFLICT (vendor_id, marketplace_garment_type_id) WHERE marketplace_garment_type_id IS NOT NULL DO UPDATE SET
             name = CASE WHEN pos_garments.locally_edited THEN pos_garments.name ELSE EXCLUDED.name END,
             unit = CASE WHEN pos_garments.locally_edited THEN pos_garments.unit ELSE EXCLUDED.unit END,
             image_url = CASE WHEN pos_garments.locally_edited THEN pos_garments.image_url ELSE EXCLUDED.image_url END,
             category_id = CASE WHEN pos_garments.locally_edited THEN pos_garments.category_id ELSE EXCLUDED.category_id END,
             active = CASE WHEN pos_garments.marketplace_missing AND NOT pos_garments.locally_edited THEN true ELSE pos_garments.active END,
             marketplace_missing = false, updated_at = NOW()
           RETURNING id`, [vendorId, catMap.get(row.category_id) || null, row.garment_name, normalizeUnit(row.unit), image, row.garment_type_id])
        garMap.set(row.garment_type_id, r.rows[0].id)
      }
      summary.garments = garMap.size

      // Prices: refresh the reference (marketplace) price always; refresh the POS price only when the vendor has not overridden it.
      for (const row of rows) {
        const r = await client.query(
          `INSERT INTO pos_prices (vendor_id, garment_id, service_id, rate_paise, source, marketplace_rate_id, marketplace_rate_paise)
           VALUES ($1, $2, $3, $4, 'MARKETPLACE', $5, $4)
           ON CONFLICT (vendor_id, marketplace_rate_id) WHERE marketplace_rate_id IS NOT NULL DO UPDATE SET
             marketplace_rate_paise = EXCLUDED.marketplace_rate_paise,
             rate_paise = CASE WHEN pos_prices.price_overridden THEN pos_prices.rate_paise ELSE EXCLUDED.rate_paise END,
             active = CASE WHEN pos_prices.marketplace_missing AND NOT pos_prices.price_overridden THEN true ELSE pos_prices.active END,
             marketplace_missing = false, updated_at = NOW()
           RETURNING price_overridden, rate_paise`, [vendorId, garMap.get(row.garment_type_id), svcMap.get(row.service_id), row.rate_paise, row.rate_id])
        summary.prices += 1
        if (r.rows[0].price_overridden && r.rows[0].rate_paise !== row.rate_paise) summary.priceChangesKept += 1
      }

      // Marketplace-sourced rows the vendor no longer offers there: hide them (kept if the vendor customised them).
      const seen = {
        pos_categories: ['marketplace_category_id', [...catMap.keys()], 'locally_edited'],
        pos_services: ['marketplace_service_id', [...svcMap.keys()], 'locally_edited'],
        pos_garments: ['marketplace_garment_type_id', [...garMap.keys()], 'locally_edited'],
        pos_prices: ['marketplace_rate_id', rows.map((r) => r.rate_id), 'price_overridden'],
      }
      for (const [table, [column, ids, keepFlag]] of Object.entries(seen)) {
        const res = await client.query(
          `UPDATE ${table} SET marketplace_missing = true, active = CASE WHEN ${keepFlag} THEN active ELSE false END, updated_at = NOW()
           WHERE vendor_id = $1 AND source = 'MARKETPLACE' AND ${column} IS NOT NULL AND ${column} <> ALL($2::uuid[]) AND NOT marketplace_missing`, [vendorId, ids])
        summary.removed += res.rowCount || 0
      }

      await client.query(
        `INSERT INTO pos_catalogue_state (vendor_id, last_synced_at, feed_hash) VALUES ($1, NOW(), $2)
         ON CONFLICT (vendor_id) DO UPDATE SET last_synced_at = NOW(), feed_hash = EXCLUDED.feed_hash`, [vendorId, this._feedHash(rows)])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return summary
  }

  // ── Categories ─────────────────────────────────────────────────────────

  async _ownedCategory(vendorId, id) {
    if (!isUuid(id)) return null
    return (await query('SELECT * FROM pos_categories WHERE id = $1 AND vendor_id = $2', [id, vendorId])).rows[0] || null
  }

  async createCategory(vendorId, actor, input) {
    const name = cleanName(input.name, 'Category name', 120); if (name.error) return fail(name.error)
    const image = cleanImage(input.imageUrl ?? input.image)
    if (image.error) return fail(image.error)
    const parent = input.parentId ? await this._ownedCategory(vendorId, input.parentId) : null
    if (input.parentId && !parent) return fail('The parent category was not found', 'NOT_FOUND', 404)
    if (parent?.parent_id) return fail('Categories can only be nested one level deep')
    if (await this._duplicateCategory(vendorId, name.value, parent?.id || null, null)) return fail('You already have a category with this name here.', 'DUPLICATE_NAME', 409)
    const { rows } = await query(
      `INSERT INTO pos_categories (vendor_id, parent_id, name, color, image_url, sort_order, active, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'POS') RETURNING *`,
      [vendorId, parent?.id || null, name.value, input.color ? String(input.color).slice(0, 20) : null, image.value ?? null, Math.trunc(Number(input.sortOrder) || 0), input.active !== false])
    this._audit(actor, 'pos_category_created', rows[0].id, null, rows[0])
    return { success: true, category: cat(rows[0]) }
  }

  async _duplicateCategory(vendorId, name, parentId, exceptId) {
    const { rows } = await query(
      `SELECT 1 FROM pos_categories WHERE vendor_id = $1 AND lower(name) = lower($2) AND parent_id IS NOT DISTINCT FROM $3 AND ($4::uuid IS NULL OR id <> $4) LIMIT 1`,
      [vendorId, name, parentId, exceptId])
    return rows.length > 0
  }

  async updateCategory(vendorId, actor, id, input) {
    const current = await this._ownedCategory(vendorId, id)
    if (!current) return fail('Category not found', 'NOT_FOUND', 404)
    let name = current.name
    if (input.name !== undefined) { const n = cleanName(input.name, 'Category name', 120); if (n.error) return fail(n.error); name = n.value }
    const image = cleanImage(input.imageUrl ?? input.image)
    if (image.error) return fail(image.error)
    let parentId = current.parent_id
    if (input.parentId !== undefined) {
      const parent = input.parentId ? await this._ownedCategory(vendorId, input.parentId) : null
      if (input.parentId && !parent) return fail('The parent category was not found', 'NOT_FOUND', 404)
      if (parent && (parent.id === id || parent.parent_id)) return fail('Categories can only be nested one level deep')
      if (parent) {
        const children = await query('SELECT 1 FROM pos_categories WHERE parent_id = $1 AND vendor_id = $2 LIMIT 1', [id, vendorId])
        if (children.rows.length) return fail('This category has sub-categories, so it cannot be placed under another one.')
      }
      parentId = parent?.id || null
    }
    if (await this._duplicateCategory(vendorId, name, parentId, id)) return fail('You already have a category with this name here.', 'DUPLICATE_NAME', 409)
    const edited = current.source === 'MARKETPLACE' && (name !== current.name || (!image.skip && image.value !== current.image_url))
    const { rows } = await query(
      `UPDATE pos_categories SET name = $3, parent_id = $4, color = COALESCE($5, color), image_url = CASE WHEN $6 THEN $7 ELSE image_url END,
         sort_order = COALESCE($8, sort_order), active = COALESCE($9, active), locally_edited = locally_edited OR $10, updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 RETURNING *`,
      [id, vendorId, name, parentId, input.color ? String(input.color).slice(0, 20) : null, !image.skip, image.value ?? null,
        input.sortOrder === undefined ? null : Math.trunc(Number(input.sortOrder) || 0), typeof input.active === 'boolean' ? input.active : null, edited])
    this._audit(actor, 'pos_category_updated', id, current, rows[0])
    return { success: true, category: cat(rows[0]) }
  }

  // ── Services ───────────────────────────────────────────────────────────

  _cleanUnits(value) {
    if (value === undefined) return { skip: true }
    if (!Array.isArray(value)) return { error: 'Units must be a list' }
    const labels = [...new Set(value.map((entry) => unitLabel(entry)))]
    return { value: labels }
  }

  async createService(vendorId, actor, input) {
    const name = cleanName(input.name, 'Service name', 160); if (name.error) return fail(name.error)
    const image = cleanImage(input.imageUrl ?? input.image); if (image.error) return fail(image.error)
    const units = this._cleanUnits(input.units); if (units.error) return fail(units.error)
    if ((await query('SELECT 1 FROM pos_services WHERE vendor_id = $1 AND lower(name) = lower($2) LIMIT 1', [vendorId, name.value])).rows.length) return fail('You already have a service with this name.', 'DUPLICATE_NAME', 409)
    const { rows } = await query(
      `INSERT INTO pos_services (vendor_id, name, description, image_url, units, active, source) VALUES ($1, $2, $3, $4, $5, $6, 'POS') RETURNING *`,
      [vendorId, name.value, input.description ? String(input.description).slice(0, 1000) : null, image.value ?? null, units.value || Object.values(UNIT_LABEL), input.active !== false])
    this._audit(actor, 'pos_service_created', rows[0].id, null, rows[0])
    return { success: true, service: svc(rows[0]) }
  }

  async updateService(vendorId, actor, id, input) {
    const current = (await query('SELECT * FROM pos_services WHERE id = $1 AND vendor_id = $2', [id, vendorId])).rows[0]
    if (!current) return fail('Service not found', 'NOT_FOUND', 404)
    let name = current.name
    if (input.name !== undefined) { const n = cleanName(input.name, 'Service name', 160); if (n.error) return fail(n.error); name = n.value }
    const image = cleanImage(input.imageUrl ?? input.image); if (image.error) return fail(image.error)
    const units = this._cleanUnits(input.units); if (units.error) return fail(units.error)
    if ((await query('SELECT 1 FROM pos_services WHERE vendor_id = $1 AND lower(name) = lower($2) AND id <> $3 LIMIT 1', [vendorId, name, id])).rows.length) return fail('You already have a service with this name.', 'DUPLICATE_NAME', 409)
    const description = input.description === undefined ? current.description : String(input.description || '').slice(0, 1000) || null
    const edited = current.source === 'MARKETPLACE'
    const { rows } = await query(
      `UPDATE pos_services SET name = $3, description = $4, image_url = CASE WHEN $5 THEN $6 ELSE image_url END, units = COALESCE($7, units),
         active = COALESCE($8, active), locally_edited = locally_edited OR $9, updated_at = NOW() WHERE id = $1 AND vendor_id = $2 RETURNING *`,
      [id, vendorId, name, description, !image.skip, image.value ?? null, units.skip ? null : units.value, typeof input.active === 'boolean' ? input.active : null, edited])
    this._audit(actor, 'pos_service_updated', id, current, rows[0])
    return { success: true, service: svc(rows[0]) }
  }

  // ── Garments ───────────────────────────────────────────────────────────

  async _garmentFields(vendorId, input, current = null) {
    let name = current?.name
    if (input.name !== undefined || !current) { const n = cleanName(input.name, 'Garment name', 160); if (n.error) return { error: n.error }; name = n.value }
    const image = cleanImage(input.imageUrl ?? input.image ?? input.photo); if (image.error) return { error: image.error }
    let categoryId = current?.category_id ?? null
    if (input.categoryId !== undefined || input.category !== undefined) {
      const wanted = input.categoryId ?? input.category
      if (wanted) {
        const owned = await this._ownedCategory(vendorId, wanted)
        if (!owned) return { error: 'The category was not found', code: 'NOT_FOUND', status: 404 }
        categoryId = owned.id
      } else categoryId = null
    }
    const unit = input.unit !== undefined ? normalizeUnit(input.unit) : current?.unit || 'piece'
    const gst = input.gstRate === undefined ? null : Number(input.gstRate)
    if (gst !== null && (!Number.isFinite(gst) || gst < 0 || gst > 100)) return { error: 'GST rate must be between 0 and 100' }
    return { name, image, categoryId, unit, gst, code: input.code === undefined ? undefined : String(input.code || '').slice(0, 40) || null, hsn: input.hsn === undefined ? undefined : String(input.hsn || '').slice(0, 20) || null }
  }

  async createGarment(vendorId, actor, input) {
    const f = await this._garmentFields(vendorId, input); if (f.error) return fail(f.error, f.code, f.status)
    if ((await query('SELECT 1 FROM pos_garments WHERE vendor_id = $1 AND lower(name) = lower($2) AND category_id IS NOT DISTINCT FROM $3 LIMIT 1', [vendorId, f.name, f.categoryId])).rows.length) return fail('You already have a garment with this name in this category.', 'DUPLICATE_NAME', 409)
    const { rows } = await query(
      `INSERT INTO pos_garments (vendor_id, category_id, name, code, unit, image_url, hsn, gst_rate, active, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'POS') RETURNING *`,
      [vendorId, f.categoryId, f.name, f.code ?? null, f.unit, f.image.value ?? null, f.hsn ?? null, f.gst ?? 0, input.active !== false])
    this._audit(actor, 'pos_garment_created', rows[0].id, null, rows[0])
    return { success: true, garment: gar(rows[0]) }
  }

  async updateGarment(vendorId, actor, id, input) {
    const current = (await query('SELECT * FROM pos_garments WHERE id = $1 AND vendor_id = $2', [id, vendorId])).rows[0]
    if (!current) return fail('Garment not found', 'NOT_FOUND', 404)
    const f = await this._garmentFields(vendorId, input, current); if (f.error) return fail(f.error, f.code, f.status)
    if ((await query('SELECT 1 FROM pos_garments WHERE vendor_id = $1 AND lower(name) = lower($2) AND category_id IS NOT DISTINCT FROM $3 AND id <> $4 LIMIT 1', [vendorId, f.name, f.categoryId, id])).rows.length) return fail('You already have a garment with this name in this category.', 'DUPLICATE_NAME', 409)
    const edited = current.source === 'MARKETPLACE'
    const { rows } = await query(
      `UPDATE pos_garments SET name = $3, category_id = $4, unit = $5, image_url = CASE WHEN $6 THEN $7 ELSE image_url END,
         code = CASE WHEN $8 THEN $9 ELSE code END, hsn = CASE WHEN $10 THEN $11 ELSE hsn END, gst_rate = COALESCE($12, gst_rate),
         active = COALESCE($13, active), locally_edited = locally_edited OR $14, updated_at = NOW() WHERE id = $1 AND vendor_id = $2 RETURNING *`,
      [id, vendorId, f.name, f.categoryId, f.unit, !f.image.skip, f.image.value ?? null, f.code !== undefined, f.code ?? null, f.hsn !== undefined, f.hsn ?? null, f.gst, typeof input.active === 'boolean' ? input.active : null, edited])
    this._audit(actor, 'pos_garment_updated', id, current, rows[0])
    return { success: true, garment: gar(rows[0]) }
  }

  // ── Prices ─────────────────────────────────────────────────────────────

  async createPrice(vendorId, actor, input) {
    const rate = Math.round(Number(input.ratePaise))
    if (!Number.isFinite(rate) || rate < 0) return fail('Enter a rate of zero or more')
    if (!isUuid(input.garmentId) || !isUuid(input.serviceId) || (input.customerUserId && !isUuid(input.customerUserId))) return fail('Choose a garment and a service', 'VALIDATION_ERROR')
    const garment = (await query('SELECT id FROM pos_garments WHERE id = $1 AND vendor_id = $2', [input.garmentId, vendorId])).rows[0]
    const service = (await query('SELECT id FROM pos_services WHERE id = $1 AND vendor_id = $2', [input.serviceId, vendorId])).rows[0]
    if (!garment || !service) return fail('That garment or service was not found in your catalogue', 'NOT_FOUND', 404)
    let customer = null
    if (input.customerUserId) {
      customer = (await query('SELECT id FROM users WHERE id = $1', [input.customerUserId])).rows[0]
      if (!customer) return fail('That customer was not found', 'NOT_FOUND', 404)
    }
    const dup = await query(
      `SELECT 1 FROM pos_prices WHERE vendor_id = $1 AND garment_id = $2 AND service_id = $3 AND customer_user_id IS NOT DISTINCT FROM $4 LIMIT 1`, [vendorId, garment.id, service.id, customer?.id || null])
    if (dup.rows.length) return fail('A price for this garment and service already exists — edit it instead.', 'DUPLICATE_PRICE', 409)
    const { rows } = await query(
      `INSERT INTO pos_prices (vendor_id, garment_id, service_id, customer_user_id, rate_paise, active, source) VALUES ($1,$2,$3,$4,$5,$6,'POS') RETURNING *`,
      [vendorId, garment.id, service.id, customer?.id || null, rate, input.active !== false])
    this._audit(actor, 'pos_price_created', rows[0].id, null, rows[0])
    return { success: true, price: prc(rows[0]) }
  }

  async updatePrice(vendorId, actor, id, input) {
    const current = (await query('SELECT * FROM pos_prices WHERE id = $1 AND vendor_id = $2', [id, vendorId])).rows[0]
    if (!current) return fail('Price not found', 'NOT_FOUND', 404)
    let rate = current.rate_paise
    let overridden = current.price_overridden
    if (input.resetToMarketplace) {
      if (current.marketplace_rate_paise == null) return fail('This price has no LNDRY price to go back to.')
      rate = current.marketplace_rate_paise; overridden = false
    } else if (input.ratePaise !== undefined) {
      rate = Math.round(Number(input.ratePaise))
      if (!Number.isFinite(rate) || rate < 0) return fail('Enter a rate of zero or more')
      // Setting it equal to the LNDRY price is the same as following it.
      if (current.marketplace_rate_id) overridden = current.marketplace_rate_paise == null ? true : rate !== current.marketplace_rate_paise
    }
    const { rows } = await query(
      `UPDATE pos_prices SET rate_paise = $3, price_overridden = $4, active = COALESCE($5, active), updated_at = NOW() WHERE id = $1 AND vendor_id = $2 RETURNING *`,
      [id, vendorId, rate, overridden, typeof input.active === 'boolean' ? input.active : null])
    this._audit(actor, 'pos_price_updated', id, current, rows[0])
    return { success: true, price: prc(rows[0]) }
  }

  // ── Tax rules ──────────────────────────────────────────────────────────

  async saveTaxRule(vendorId, actor, id, input) {
    const current = id ? (await query('SELECT * FROM pos_tax_rules WHERE id = $1 AND vendor_id = $2', [id, vendorId])).rows[0] : null
    if (id && !current) return fail('Tax rule not found', 'NOT_FOUND', 404)
    let name = current?.name
    if (input.name !== undefined || !current) { const n = cleanName(input.name, 'Tax rule name', 120); if (n.error) return fail(n.error); name = n.value }
    let bps = current?.rate_bps
    if (input.ratePercent !== undefined || !current) {
      const percent = Number(input.ratePercent)
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return fail('Tax rate must be between 0 and 100')
      bps = Math.round(percent * 100)
    }
    const active = typeof input.active === 'boolean' ? input.active : current?.active ?? true
    const { rows } = current
      ? await query('UPDATE pos_tax_rules SET name = $3, rate_bps = $4, active = $5, updated_at = NOW() WHERE id = $1 AND vendor_id = $2 RETURNING *', [id, vendorId, name, bps, active])
      : await query('INSERT INTO pos_tax_rules (vendor_id, name, rate_bps, active) VALUES ($1,$2,$3,$4) RETURNING *', [vendorId, name, bps, active])
    return { success: true, taxRule: tax(rows[0]) }
  }

  _audit(actor, event, targetId, before, after) {
    emitAudit(event, {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'pos_catalogue', target_id: targetId,
      before, after, ip_address: actor.ip, user_agent: actor.userAgent,
    })
  }
}
