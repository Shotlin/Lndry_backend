import { query } from '../../config/database.js'

/**
 * Vendor Type (migration 143) — how much of the LNDRY ecosystem a vendor's
 * counter is connected to. The single place that turns a type into
 * capabilities, so every enforcement point asks the same question.
 *
 *   STANDARD          POS only — no customer-app sync, no LNDRY wallet
 *   PARTNER/EXCLUSIVE POS + customer-app sync + LNDRY wallet
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

export const WALLET_RESTRICTED_MESSAGE = 'LNDRY wallet is available to Partner and Exclusive vendors only.'
export const SYNC_RESTRICTED_MESSAGE = 'Linking counter sales to LNDRY customer accounts is available to Partner and Exclusive vendors only.'

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

/** Throws unless the vendor's counter is linked to the customer app. */
export async function requireAppSync(vendorId) {
  const caps = await getVendorCapabilities(vendorId)
  if (!caps.appSync) throw tierError(SYNC_RESTRICTED_MESSAGE)
  return caps
}
