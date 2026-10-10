/**
 * Vendor offering — which LNDRY products a vendor may use in the Vendor App.
 * (Not to be confused with `vendor_type`, see vendors/vendor-tier.js.)
 */
export const OFFERINGS = ['MARKETPLACE', 'POS', 'BOTH']
export const POS_ONBOARDING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']
export const APP_MODES = ['MARKETPLACE', 'POS']

export const normalizeOffering = (value) => {
  const v = String(value ?? '').trim().toUpperCase()
  return OFFERINGS.includes(v) ? v : null
}

/**
 * The modes the app may offer for this vendor. POS only becomes available once
 * POS onboarding is COMPLETED, so a half-set-up shop never lands on empty POS screens.
 */
export function allowedModesFor(offering, posOnboardingStatus) {
  const posReady = posOnboardingStatus === 'COMPLETED'
  if (offering === 'POS') return posReady ? ['POS'] : []
  if (offering === 'BOTH') return posReady ? ['MARKETPLACE', 'POS'] : ['MARKETPLACE']
  return ['MARKETPLACE']
}

/** URL prefixes (no query string) that belong to one product. Used by the flagged offering guard. */
export const POS_ROUTE_PREFIXES = [
  '/api/v1/vendor/counter',
  '/api/v1/vendor/counter-sales',
  '/api/v1/vendor/pos',
  '/api/v1/vendor/pos-catalogue',
  '/api/v1/vendor/pos-settings',
  '/api/v1/vendor/cash-shifts',
  '/api/v1/vendor/customer-profiles',
  '/api/v1/vendor/customer-ledger',
  '/api/v1/vendor/order-holds',
  '/api/v1/vendor/imports',
]
export const MARKETPLACE_ROUTE_PREFIXES = [
  '/api/v1/vendor/orders',
  '/api/v1/vendor-orders',
  '/api/v1/vendor/rider',
]

const matchesPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`)

/** 'POS' | 'MARKETPLACE' | null — which product a request path belongs to. */
export function productForPath(path) {
  const clean = String(path || '').split('?')[0]
  if (POS_ROUTE_PREFIXES.some((p) => matchesPrefix(clean, p))) return 'POS'
  if (MARKETPLACE_ROUTE_PREFIXES.some((p) => matchesPrefix(clean, p))) return 'MARKETPLACE'
  return null
}

/** Is a vendor with this offering entitled to the product? */
export const offeringAllows = (offering, product) =>
  offering === 'BOTH' || offering === product
