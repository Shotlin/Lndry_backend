import { query } from '../../config/database.js'

/**
 * Vendor Type (migration 143) — how deeply a vendor's POS (the in-store /
 * walk-in counter) is connected to the LNDRY customer ecosystem. The single
 * place that turns a type into capabilities, so every enforcement point asks
 * the same question.
 *
 * EVERY vendor type is a full LNDRY marketplace vendor: Vendor App, services
 * listed in the customer app, online orders, normal app payments (including
 * the customer's LNDRY wallet at app checkout). The type NEVER limits any of
 * that — nothing in the marketplace code reads it (a unit test guards this).
 *
 * It only governs POS walk-in transactions:
 *   STANDARD          walk-in POS sales stay the vendor's own (not synced to the
 *                     customer's LNDRY app); the POS cannot view or use the
 *                     customer's LNDRY wallet
 *   PARTNER/EXCLUSIVE connected POS: walk-in sales sync to the customer's LNDRY
 *                     app and the POS can view / use the LNDRY wallet
 *
 * (`appSync` = POS walk-in sale sync + LNDRY-account lookup by phone;
 *  `walletAccess` = LNDRY wallet at the POS counter.)
 */
export const VENDOR_TYPES = ['STANDARD', 'PARTNER', 'EXCLUSIVE']

export const TIER_RESTRICTED = 'VENDOR_TIER_RESTRICTED'

export function normalizeVendorType(value) {
  const type = String(value ?? '').trim().toUpperCase()
  return VENDOR_TYPES.includes(type) ? type : null
}

export function capabilitiesFor(vendorType) {
  const connected = vendorType === 'PARTNER' || vendorType === 'EXCLUSIVE'
  return { vendorType, appSync: connected, walletAccess: connected }
}

/**
 * The vendor's CURRENT type, read fresh from the database on every call — an
 * admin's change takes effect on the very next request, on every instance.
 * Unknown / missing vendor resolves to STANDARD (fail closed).
 */
export async function getVendorCapabilities(vendorId, db = { query }) {
  if (!vendorId) return capabilitiesFor('STANDARD')
  const { rows } = await db.query('SELECT vendor_type FROM vendors WHERE id = $1 AND deleted_at IS NULL', [vendorId])
  return capabilitiesFor(normalizeVendorType(rows[0]?.vendor_type) || 'STANDARD')
}

export const WALLET_RESTRICTED_MESSAGE = 'Using the LNDRY wallet at the POS counter is available to Partner and Exclusive vendors only.'
export const SYNC_RESTRICTED_MESSAGE = 'Linking POS walk-in sales to LNDRY customer accounts is available to Partner and Exclusive vendors only.'

/** Throwable in the `{ statusCode, message, code }` shape the services use. */
export function tierError(message) {
  return { statusCode: 403, message, code: TIER_RESTRICTED }
}

/** Throws unless the vendor may use the LNDRY wallet. */
export async function requireWalletAccess(vendorId) {
  const caps = await getVendorCapabilities(vendorId)
  if (!caps.walletAccess) throw tierError(WALLET_RESTRICTED_MESSAGE)
  return caps
}

/** Throws unless the vendor's POS is connected to LNDRY customer accounts (walk-in sale sync + account lookup). */
export async function requireAppSync(vendorId) {
  const caps = await getVendorCapabilities(vendorId)
  if (!caps.appSync) throw tierError(SYNC_RESTRICTED_MESSAGE)
  return caps
}
