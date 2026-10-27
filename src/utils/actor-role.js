/**
 * Effective-role normalisation for verified JWT payloads.
 *
 * Why this exists: vendor-employee accounts are stored with `users.role =
 * 'ADMIN'` (see vendor-employees.repository#createUserWithPassword), and the
 * shop-staff login copies that value into the token's `role` claim next to
 * `shopId` / `shopRole`. Dozens of guards trust `request.user.role === 'ADMIN'`
 * alone (`authorize(['ADMIN'])`, `isHqUser`, `requireSuperAdmin`, the socket
 * admin room ...), so a cashier's token passed every "platform admin" check:
 * wallet credits, refunds, payouts, cross-shop reads.
 *
 * A token that is scoped to a shop (carries `shopId` / `shopRole`) and has no
 * `platform_role` belongs to shop staff, never to platform HQ, so its
 * platform-admin role is downgraded to `SHOP_STAFF` at the single place every
 * token is verified. HQ tokens (which carry `platform_role`) and ordinary
 * customer / rider tokens are untouched. The original value stays available as
 * `account_role` for audit logging.
 *
 * Emergency escape hatch: LEGACY_SHOP_STAFF_ADMIN_ROLE=true restores the old
 * behaviour. It exists only so a production rollback never needs a code change.
 */
const PLATFORM_ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE_ADMIN'])

export function normalizeActorRole(payload) {
  if (!payload || typeof payload !== 'object') return payload
  if (process.env.LEGACY_SHOP_STAFF_ADMIN_ROLE === 'true') return payload
  if (!PLATFORM_ADMIN_ROLES.has(payload.role)) return payload
  if (payload.platform_role) return payload

  const shopScoped = Boolean(payload.shopId || payload.shopRole || payload.shop_role)
  if (!shopScoped) return payload

  return { ...payload, account_role: payload.role, role: 'SHOP_STAFF' }
}
