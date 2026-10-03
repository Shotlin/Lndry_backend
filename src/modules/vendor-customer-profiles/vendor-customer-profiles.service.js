import { query } from '../../config/database.js'
import { emit as emitAudit } from '../../utils/audit-log.js'

/**
 * What THIS vendor knows about a customer: display name, e-mail, notes and
 * addresses. Stored in the vendor's own tables — the shared LNDRY account
 * (users / addresses) is never rewritten from the counter, so a person who also
 * uses the app, or who is a customer of other vendors, is unaffected.
 */

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ''))
const fail = (message, code = 'VALIDATION_ERROR', status = 400) => ({ success: false, message, code, status })
const text = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const addressShape = (r) => ({
  id: r.id, label: r.label, addressLine1: r.address_line1, addressLine2: r.address_line2 || '', landmark: r.landmark || '',
  city: r.city || '', state: r.state || '', pincode: r.pincode || '', isDefault: r.is_default, createdAt: r.created_at,
})
const CONTACTS = new Set(['Phone', 'WhatsApp', 'Email', 'None'])
const profileShape = (r) => ({
  displayName: r?.display_name || '', email: r?.email || '', notes: r?.notes || '',
  servicePreferences: r?.service_preferences || '', preferredContact: r?.preferred_contact || null, marketingConsent: r?.marketing_consent ?? null,
})

export class VendorCustomerProfilesService {
  /** A vendor may only manage customers it has dealt with (a sale, an app order, a ledger entry or a counter look-up). */
  async _known(vendorId, customerId) {
    if (!isUuid(customerId)) return false
    const { rows } = await query(
      `SELECT 1 FROM vendor_customer_profiles WHERE vendor_id = $1 AND customer_user_id = $2
       UNION ALL SELECT 1 FROM store_orders WHERE vendor_id = $1 AND customer_user_id = $2
       UNION ALL SELECT 1 FROM orders WHERE vendor_id = $1 AND user_id = $2
       UNION ALL SELECT 1 FROM vendor_customer_ledger WHERE vendor_id = $1 AND customer_user_id = $2
       LIMIT 1`,
      [vendorId, customerId]
    )
    return rows.length > 0
  }

  /** Make sure a profile row exists for a customer the counter has just looked up or created. */
  async ensureProfile(vendorId, customerId, displayName = null) {
    await query(
      `INSERT INTO vendor_customer_profiles (vendor_id, customer_user_id, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (vendor_id, customer_user_id) DO NOTHING`,
      [vendorId, customerId, displayName || null]
    )
  }

  async get(vendorId, customerId) {
    if (!(await this._known(vendorId, customerId))) return fail('Customer not found', 'NOT_FOUND', 404)
    const profile = (await query('SELECT * FROM vendor_customer_profiles WHERE vendor_id = $1 AND customer_user_id = $2', [vendorId, customerId])).rows[0]
    const addresses = await this.listAddresses(vendorId, customerId)
    return { success: true, profile: profileShape(profile), addresses: addresses.addresses }
  }

  async update(vendorId, actor, customerId, input) {
    if (!(await this._known(vendorId, customerId))) return fail('Customer not found', 'NOT_FOUND', 404)
    const sets = { name: input.name, email: input.email, notes: input.notes }
    const name = sets.name === undefined ? undefined : text(sets.name, 100)
    if (name !== undefined && !name) return fail('Customer name cannot be empty')
    const email = sets.email === undefined ? undefined : text(sets.email, 160).toLowerCase()
    if (email && !EMAIL.test(email)) return fail('Enter a valid e-mail address')
    const notes = sets.notes === undefined ? undefined : String(sets.notes ?? '').trim().slice(0, 2000)
    const prefs = input.servicePreferences === undefined ? undefined : String(input.servicePreferences ?? '').trim().slice(0, 2000)
    if (input.preferredContact !== undefined && input.preferredContact !== null && input.preferredContact !== '' && !CONTACTS.has(input.preferredContact)) return fail('Choose Phone, WhatsApp, Email or None as the preferred contact')
    const contact = input.preferredContact === undefined ? undefined : (input.preferredContact || null)
    const consent = input.marketingConsent === undefined ? undefined : (input.marketingConsent === null ? null : input.marketingConsent === true)
    const { rows } = await query(
      `INSERT INTO vendor_customer_profiles (vendor_id, customer_user_id, display_name, email, notes, service_preferences, preferred_contact, marketing_consent)
       VALUES ($1, $2, $3, $4, $5, $9, $10, $11)
       ON CONFLICT (vendor_id, customer_user_id) DO UPDATE SET
         display_name = CASE WHEN $6 THEN EXCLUDED.display_name ELSE vendor_customer_profiles.display_name END,
         email = CASE WHEN $7 THEN EXCLUDED.email ELSE vendor_customer_profiles.email END,
         notes = CASE WHEN $8 THEN EXCLUDED.notes ELSE vendor_customer_profiles.notes END,
         service_preferences = CASE WHEN $12 THEN EXCLUDED.service_preferences ELSE vendor_customer_profiles.service_preferences END,
         preferred_contact = CASE WHEN $13 THEN EXCLUDED.preferred_contact ELSE vendor_customer_profiles.preferred_contact END,
         marketing_consent = CASE WHEN $14 THEN EXCLUDED.marketing_consent ELSE vendor_customer_profiles.marketing_consent END,
         updated_at = NOW()
       RETURNING *`,
      [vendorId, customerId, name ?? null, email || null, notes ?? null, name !== undefined, email !== undefined, notes !== undefined,
        prefs ?? null, contact ?? null, consent ?? null, prefs !== undefined, contact !== undefined, consent !== undefined]
    )
    emitAudit('vendor_customer_profile_updated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'user', target_id: customerId,
      before: null, after: { vendorId, fields: Object.keys(input).filter((k) => ['name', 'email', 'notes'].includes(k)) }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, profile: profileShape(rows[0]) }
  }

  async listAddresses(vendorId, customerId) {
    if (!(await this._known(vendorId, customerId))) return fail('Customer not found', 'NOT_FOUND', 404)
    const { rows } = await query(
      `SELECT * FROM vendor_customer_addresses WHERE vendor_id = $1 AND customer_user_id = $2 AND archived = false ORDER BY is_default DESC, created_at ASC`,
      [vendorId, customerId]
    )
    return { success: true, addresses: rows.map(addressShape) }
  }

  _addressFields(input) {
    const line1 = text(input.addressLine1 ?? input.line1 ?? input.address, 255)
    if (!line1) return { error: 'Address line is required' }
    const pincode = text(input.pincode ?? input.postalCode, 10)
    if (pincode && !/^[0-9A-Za-z -]{3,10}$/.test(pincode)) return { error: 'Enter a valid pincode' }
    return {
      label: text(input.label, 50) || 'Home', line1, line2: text(input.addressLine2 ?? input.line2, 255) || null,
      landmark: text(input.landmark, 255) || null, city: text(input.city, 100) || null, state: text(input.state, 100) || null, pincode: pincode || null,
    }
  }

  async createAddress(vendorId, actor, customerId, input) {
    if (!(await this._known(vendorId, customerId))) return fail('Customer not found', 'NOT_FOUND', 404)
    const f = this._addressFields(input); if (f.error) return fail(f.error)
    const count = (await query('SELECT COUNT(*)::int AS n FROM vendor_customer_addresses WHERE vendor_id = $1 AND customer_user_id = $2 AND archived = false', [vendorId, customerId])).rows[0].n
    if (count >= 20) return fail('A customer can have at most 20 saved addresses')
    const makeDefault = input.isDefault === true || count === 0
    if (makeDefault) await query('UPDATE vendor_customer_addresses SET is_default = false WHERE vendor_id = $1 AND customer_user_id = $2', [vendorId, customerId])
    const { rows } = await query(
      `INSERT INTO vendor_customer_addresses (vendor_id, customer_user_id, label, address_line1, address_line2, landmark, city, state, pincode, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [vendorId, customerId, f.label, f.line1, f.line2, f.landmark, f.city, f.state, f.pincode, makeDefault]
    )
    return { success: true, address: addressShape(rows[0]) }
  }

  async updateAddress(vendorId, actor, customerId, addressId, input) {
    if (!isUuid(addressId)) return fail('Address not found', 'NOT_FOUND', 404)
    const current = (await query('SELECT * FROM vendor_customer_addresses WHERE id = $1 AND vendor_id = $2 AND customer_user_id = $3 AND archived = false', [addressId, vendorId, customerId])).rows[0]
    if (!current) return fail('Address not found', 'NOT_FOUND', 404)
    const f = this._addressFields({
      label: current.label, addressLine1: current.address_line1, addressLine2: current.address_line2, landmark: current.landmark,
      city: current.city, state: current.state, pincode: current.pincode, ...input,
    })
    if (f.error) return fail(f.error)
    if (input.isDefault === true) await query('UPDATE vendor_customer_addresses SET is_default = false WHERE vendor_id = $1 AND customer_user_id = $2', [vendorId, customerId])
    const { rows } = await query(
      `UPDATE vendor_customer_addresses SET label=$4, address_line1=$5, address_line2=$6, landmark=$7, city=$8, state=$9, pincode=$10,
         is_default = CASE WHEN $11 THEN true ELSE is_default END, updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 AND customer_user_id = $3 RETURNING *`,
      [addressId, vendorId, customerId, f.label, f.line1, f.line2, f.landmark, f.city, f.state, f.pincode, input.isDefault === true]
    )
    return { success: true, address: addressShape(rows[0]) }
  }

  async archiveAddress(vendorId, actor, customerId, addressId) {
    if (!isUuid(addressId)) return fail('Address not found', 'NOT_FOUND', 404)
    const { rows } = await query(
      `UPDATE vendor_customer_addresses SET archived = true, is_default = false, updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 AND customer_user_id = $3 AND archived = false RETURNING id`,
      [addressId, vendorId, customerId]
    )
    if (!rows[0]) return fail('Address not found', 'NOT_FOUND', 404)
    // Keep one default address if any remain.
    await query(
      `UPDATE vendor_customer_addresses SET is_default = true WHERE id = (
         SELECT id FROM vendor_customer_addresses WHERE vendor_id = $1 AND customer_user_id = $2 AND archived = false ORDER BY created_at ASC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM vendor_customer_addresses WHERE vendor_id = $1 AND customer_user_id = $2 AND archived = false AND is_default = true)`,
      [vendorId, customerId]
    )
    return { success: true, archived: true }
  }
}
