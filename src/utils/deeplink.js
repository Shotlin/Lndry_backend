/**
 * Notification deep-link contract.
 *
 * A notification carries a *logical* destination — `{ type, params }` — and the
 * backend resolves it to the concrete in-app route for the recipient's app
 * (customer or partner) and, for the partner app, their role (vendor or
 * captain). The apps only ever navigate to routes matching their own whitelist,
 * so a payload can never send a user to an arbitrary path.
 *
 * FCM `data` values must all be strings; `buildLinkData` produces exactly that.
 */

export const DEEP_LINK_TYPES = [
  'home',
  'orders',
  'order_details',
  'vendor_details',
  'offers',
  'wallet',
  'notifications',
  'help',
  'profile',
  'refer_earn',
  'rider_job',
  'route',
]

/** Logical type → route template, per app. `:x` is filled from params. */
const CUSTOMER_ROUTES = {
  home: '/home',
  orders: '/orders',
  order_details: '/orders/details/:orderId',
  vendor_details: '/vendor/:vendorId',
  offers: '/profile/offers',
  wallet: '/profile/wallet',
  notifications: '/profile/notifications',
  help: '/profile/help',
  profile: '/profile',
  refer_earn: '/profile/refer-earn',
}

const VENDOR_ROUTES = {
  home: '/dashboard',
  orders: '/orders',
  order_details: '/orders/details/:orderId',
  notifications: '/profile/notifications',
  help: '/profile/help',
  profile: '/profile',
}

const CAPTAIN_ROUTES = {
  home: '/rider/jobs',
  orders: '/rider/jobs',
  order_details: '/rider/jobs/:orderId',
  rider_job: '/rider/jobs/:orderId',
  notifications: '/profile/notifications',
  help: '/profile/help',
  profile: '/profile',
}

/** Which params each type needs (validated before a campaign is saved). */
export const REQUIRED_PARAMS = {
  order_details: ['orderId'],
  rider_job: ['orderId'],
  vendor_details: ['vendorId'],
  route: ['route'],
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function routesFor(app, shopRole) {
  if (app === 'partner') return shopRole === 'VENDOR_RIDER' ? CAPTAIN_ROUTES : VENDOR_ROUTES
  return CUSTOMER_ROUTES
}

/** A custom route must be a plain in-app path: no scheme/host, no traversal. */
export function isSafeRoute(route) {
  return typeof route === 'string'
    && route.length <= 200
    && route.startsWith('/')
    && !route.startsWith('//')
    && !route.includes('://')
    && !route.includes('..')
    && !/[\s<>"']/.test(route)
}

/**
 * Validate an admin-supplied link. Returns `{ ok, error?, link? }` where `link`
 * is the normalised `{ type, params }`.
 */
export function validateLink(input) {
  if (!input || !input.type) return { ok: true, link: null }
  const type = String(input.type)
  if (!DEEP_LINK_TYPES.includes(type)) return { ok: false, error: `Unknown link type "${type}"` }
  const params = {}
  for (const [k, v] of Object.entries(input.params || {})) {
    if (v === null || v === undefined || v === '') continue
    params[k] = String(v)
  }
  for (const key of REQUIRED_PARAMS[type] || []) {
    if (!params[key]) return { ok: false, error: `"${type}" needs ${key}` }
  }
  if (params.orderId && !ID_PATTERN.test(params.orderId)) return { ok: false, error: 'Invalid orderId' }
  if (params.vendorId && !ID_PATTERN.test(params.vendorId)) return { ok: false, error: 'Invalid vendorId' }
  if (type === 'route' && !isSafeRoute(params.route)) return { ok: false, error: 'Custom route must be an in-app path like /profile/wallet' }
  return { ok: true, link: { type, params } }
}

/**
 * Resolve a logical link for one recipient. Falls back to the notifications
 * screen when the destination does not exist in that app (e.g. wallet for a
 * captain), so a tap always lands somewhere sensible.
 */
export function resolveLink(link, { app = 'customer', shopRole = null } = {}) {
  if (!link || !link.type) return null
  const params = link.params || {}
  if (link.type === 'route') {
    return isSafeRoute(params.route)
      ? { type: 'route', route: params.route, params }
      : null
  }
  const routes = routesFor(app, shopRole)
  let type = link.type
  let template = routes[type]
  if (!template) {
    type = 'notifications'
    template = routes.notifications
  }
  const missing = (template.match(/:(\w+)/g) || []).some((p) => !params[p.slice(1)])
  if (missing) {
    // e.g. order_details without an orderId — send them to the list instead.
    type = 'orders'
    template = routes.orders || routes.home
  }
  const route = template.replace(/:(\w+)/g, (_, k) => encodeURIComponent(params[k] ?? ''))
  return { type, route, params }
}

/**
 * Derive a link for the transactional notifications that predate the
 * contract (they only ever set `type` and `data.orderId`).
 */
export function inferLink(legacyType, data = {}) {
  const t = String(legacyType || '').toLowerCase()
  const orderId = data.orderId || data.order_id
  if (orderId) return { type: 'order_details', params: { orderId: String(orderId) } }
  if (t.includes('wallet')) return { type: 'wallet', params: {} }
  if (t.includes('refer')) return { type: 'refer_earn', params: {} }
  if (t.includes('coupon') || t.includes('offer') || t.includes('milestone')) return { type: 'offers', params: {} }
  if (t.includes('order')) return { type: 'orders', params: {} }
  return { type: 'notifications', params: {} }
}

/** The all-string `data` block every push carries. */
export function buildLinkData(resolved) {
  if (!resolved) return {}
  const out = { type: resolved.type, deepLink: resolved.route || '' }
  for (const [k, v] of Object.entries(resolved.params || {})) {
    if (k !== 'route') out[k] = String(v)
  }
  return out
}

/** Human-readable description for dashboards/logs. */
export function describeLink(link) {
  if (!link || !link.type) return 'None'
  const p = link.params || {}
  const extra = p.orderId || p.vendorId || p.route
  return extra ? `${link.type} (${extra})` : link.type
}
