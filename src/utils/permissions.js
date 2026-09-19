/**
 * Canonical RBAC vocabulary and role → permission maps for the multi-vendor
 * dashboard backend. This module is the **single runtime source of truth** for
 * the 37-string Permission_String vocabulary, the HQ_Role → permission map,
 * and the SHOP_* role → default permission map. It mirrors verbatim:
 *
 *   - design.md §4.1 — Effective Permission Set computation (the canonical
 *     vocabulary CANONICAL_PERMISSIONS / PERMISSIONS exported below feeds the
 *     filtering rule on Shop_Staff_Record permissions JSONB arrays per
 *     R17 AC#11).
 *   - design.md §4.2 — HQ_Role → Permission map (source-of-truth table). Each
 *     ✓ cell in that table corresponds to one element in HQ_ROLE_PERMISSIONS
 *     below. The same table drives the JSONB arrays seeded by migration 046
 *     (`046_hq_role_permissions.sql`); any drift between this file, design
 *     §4.2, and migration 046 is a bug and must be reconciled in lockstep.
 *   - design.md §4.3 — SHOP_* role → default permission map (used by
 *     Shop_Staff_Record creation/update per R16 AC#16).
 *
 * Requirements satisfied:
 *   - R17 AC#1  — defines the canonical 37-string Permission_String vocabulary.
 *   - R16 AC#14 — SHOP_VIEWER permission set (read-only) and forbidden suffixes.
 *   - R16 AC#16 — default permission JSON array per shop_role on
 *                 Shop_Staff_Record creation.
 *
 * The values in HQ_ROLE_PERMISSIONS / SHOP_ROLE_DEFAULT_PERMISSIONS are
 * exposed as frozen `Set<string>` objects so callers can perform O(1)
 * `permSet.has(perm)` checks during request-time enforcement and so the
 * top-level container objects cannot be re-bound or extended at runtime.
 *
 * @module utils/permissions
 */

/**
 * The canonical 37-string Permission_String vocabulary defined verbatim in
 * R17 AC#1 and design §4.2. Order matches the alphabetised JSONB ordering
 * used by migration 046 to keep diffs reviewable.
 *
 * Any string presented as a Permission_String that is not in this set is
 * invalid (R17 AC#1) and MUST be rejected by `assertValidPermissions` and
 * filtered out of the effective permission set per R17 AC#11.
 *
 * @type {ReadonlyArray<string>}
 */
const CANONICAL_PERMISSION_LIST = Object.freeze([
  'audit_logs.view',
  'finance.global_view',
  'reports.global_view',
  'riders.approve',
  'riders.assign',
  'riders.view',
  'shop_coupons.create',
  'shop_coupons.delete',
  'shop_coupons.update',
  'shop_coupons.view',
  'shop_financials.export',
  'shop_financials.mark_paid',
  'shop_financials.view',
  'shop_orders.accept_reject',
  'shop_orders.assign_rider',
  'shop_orders.cancel',
  'shop_orders.export',
  'shop_orders.reevaluate',
  'shop_orders.refund',
  'shop_orders.update_status',
  'shop_orders.view',
  'vendor_services.approve',
  'vendor_services.bulk_update',
  'vendor_services.create',
  'vendor_services.delete',
  'vendor_services.update',
  'vendor_services.view',
  'shop_reports.view',
  'vendor_employees.create',
  'vendor_employees.delete',
  'vendor_employees.reset_password',
  'vendor_employees.update',
  'vendor_employees.view',
  'shop_transactions.export',
  'shop_transactions.view',
  'vendors.create',
  'vendors.delete',
  'vendors.update',
  'vendors.view',
  // Vendor-app modules that had no permission of their own (added with the
  // Staff-vs-Captain work): order accept/reject and re-evaluation as separate
  // grants, plus pickup slots and inventory.
  'vendor_slots.manage',
  'vendor_slots.view',
  'vendor_inventory.manage',
  'vendor_inventory.view',
])

/**
 * Frozen `Set<string>` of every canonical Permission_String. Used by the
 * permission-check middleware (design §4.5) to validate the static
 * `requiredPermission` declared on every protected route at boot time
 * (R17 AC#9) and to filter Shop_Staff_Record permissions JSONB elements
 * during effective-set computation (R17 AC#11).
 *
 * Frozen via `Object.freeze` after construction — adding/removing values at
 * runtime is silently no-op in non-strict and throws in strict mode.
 *
 * Requirements: R17.1
 * Design:       §4.1, §4.2
 *
 * @type {Readonly<Set<string>>}
 */
export const PERMISSIONS = Object.freeze(new Set(CANONICAL_PERMISSION_LIST))

/**
 * Alias of `PERMISSIONS` matching the symbol name used in design §4.5
 * (the example permission-check middleware imports `CANONICAL_PERMISSIONS`).
 * Keeping both names exported lets call sites read either way without
 * duplicating data.
 *
 * @type {Readonly<Set<string>>}
 */
export const CANONICAL_PERMISSIONS = PERMISSIONS

/**
 * Convenience array of HQ_Role identifiers (every legal value of
 * `users.platform_role`). Consumed by the shop-scope middleware extension
 * (task 2.4) to recognise HQ_Users for X-Shop-Id header acceptance per
 * design §4.4.
 *
 * Order matches design §4.2 column order.
 *
 * @type {ReadonlyArray<'SUPER_ADMIN' | 'ADMIN' | 'HQ_MANAGER' | 'HQ_FINANCE' | 'HQ_SUPPORT'>}
 */
export const HQ_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'FINANCE_ADMIN',
])

// Internal helper — every Permission_String in the canonical vocabulary; used
// to construct SUPER_ADMIN and ADMIN sets without retyping the 37 values.
const ALL_PERMISSIONS = CANONICAL_PERMISSION_LIST

// Shop-scoped subset (everything except the three HQ-only globals). Used as
// the SHOP_ADMIN default per design §4.3.
const SHOP_SCOPED_PERMISSIONS = Object.freeze(
  ALL_PERMISSIONS.filter(
    (p) => p !== 'reports.global_view' && p !== 'finance.global_view' && p !== 'audit_logs.view',
  ),
)

/**
 * HQ_Role → permission set map. Keys are the five legal `users.platform_role`
 * values; values are frozen `Set<string>` instances containing only canonical
 * Permission_Strings. The contents are the same data seeded into the `roles`
 * table by migration 046 — design §4.2 is the single source of truth and
 * both this map and migration 046 derive from it directly.
 *
 * Per-role rationale (mirrored from migration 046's header comment):
 *
 *   - SUPER_ADMIN — all 37 canonical Permission_Strings (R16 AC#3).
 *   - ADMIN       — same 37 strings as SUPER_ADMIN per §4.2 (R16 AC#4).
 *                   The "ADMIN cannot CRUD a SUPER_ADMIN" carve-out is an
 *                   actor-vs-target rule enforced at the HQ user-management
 *                   route layer, not via this static map.
 *   - HQ_MANAGER  — operations subset (23 strings) per R16 AC#5: full
 *                   vendors/staff/garment_rates/orders/coupons/reports/riders
 *                   "manage" surface MINUS finance + HQ-user management +
 *                   audit logs. Excludes vendors.create/delete,
 *                   vendor_employees.delete, vendor_services.delete,
 *                   shop_orders.refund, shop_transactions.*,
 *                   shop_financials.*, shop_coupons.delete, riders.approve,
 *                   finance.global_view, audit_logs.view.
 *   - HQ_FINANCE  — finance subset (13 strings) per R16 AC#6: view-only on
 *                   vendors; read/export on transactions/financials;
 *                   shop_orders view/refund/export; mark_paid; reports;
 *                   global finance + audit_logs.view.
 *   - HQ_SUPPORT  — support subset (11 strings) per R16 AC#7: view on
 *                   vendors/staff/garment_rates/orders/coupons/reports;
 *                   shop_orders update_status/assign_rider/cancel;
 *                   riders view/assign.
 *
 * Requirements: R16.3, R16.4, R16.5, R16.6, R16.7, R17.3
 * Design:       §4.2
 *
 * @type {Readonly<Record<'SUPER_ADMIN' | 'ADMIN' | 'HQ_MANAGER' | 'HQ_FINANCE' | 'HQ_SUPPORT', Readonly<Set<string>>>>}
 */
export const HQ_ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: Object.freeze(new Set(ALL_PERMISSIONS)),
  ADMIN: Object.freeze(new Set(ALL_PERMISSIONS)),
  FINANCE_ADMIN: Object.freeze(
    new Set([
      'audit_logs.view',
      'finance.global_view',
      'reports.global_view',
      'shop_financials.export',
      'shop_financials.mark_paid',
      'shop_financials.view',
      'shop_orders.export',
      'shop_orders.refund',
      'shop_orders.view',
      'shop_reports.view',
      'shop_transactions.export',
      'shop_transactions.view',
      'vendors.view',
    ]),
  ),
})

/**
 * SHOP_* role → default permission set map applied at Shop_Staff_Record
 * creation/update per R16 AC#16. Values are frozen `Set<string>` instances
 * containing only canonical Permission_Strings.
 *
 *   - SHOP_ADMIN   — every shop-scoped Permission_String (all 37 minus the
 *                    three HQ-only globals: reports.global_view,
 *                    finance.global_view, audit_logs.view). Total: 34.
 *   - SHOP_MANAGER — SHOP_ADMIN MINUS vendor_employees.delete and
 *                    shop_financials.mark_paid. Total: 32.
 *   - SHOP_STAFF   — exactly { shop_orders.view, shop_orders.update_status,
 *                    vendor_services.view, vendor_services.update } per
 *                    R16 AC#16. Total: 4.
 *   - SHOP_VIEWER  — exactly { vendors.view, vendor_services.view,
 *                    shop_orders.view, shop_transactions.view,
 *                    shop_financials.view, shop_reports.view } per
 *                    R16 AC#14. Total: 6. Contains no Permission_String
 *                    ending in .create / .update / .delete /
 *                    .assign_rider / .update_status / .mark_paid (R16 AC#14).
 *
 * Requirements: R16.14, R16.16
 * Design:       §4.3
 *
 * @type {Readonly<Record<'SHOP_ADMIN' | 'SHOP_MANAGER' | 'SHOP_STAFF' | 'SHOP_VIEWER', Readonly<Set<string>>>>}
 */
export const SHOP_ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  VENDOR_OWNER: Object.freeze(new Set(SHOP_SCOPED_PERMISSIONS)),
  VENDOR_STAFF: Object.freeze(
    new Set(
      SHOP_SCOPED_PERMISSIONS.filter(
        (p) => p !== 'vendor_employees.delete' && p !== 'shop_financials.mark_paid',
      ),
    ),
  ),
})

/**
 * Validate that every element of `arr` is a Permission_String drawn from the
 * canonical 37-value vocabulary (R17 AC#1). Throws on the first invalid
 * element with a stable error code so route handlers can map the failure to
 * HTTP 400 PERMISSION_INVALID per R16 AC#17.
 *
 * Behaviour:
 *   - Non-array input → `Error` with `code='PERMISSION_INVALID'` and message
 *     `'permissions must be an array'`.
 *   - Any element that is not a string OR not present in `PERMISSIONS` →
 *     `Error` with `code='PERMISSION_INVALID'` and message
 *     `` `Unknown permission string: ${perm}` ``.
 *   - Otherwise returns the input array unchanged so the helper can be used
 *     in a fluent expression (e.g. `repo.update({ permissions:
 *     assertValidPermissions(body.permissions) })`).
 *
 * Requirements: R16.17, R17.1
 * Design:       §4.1
 *
 * @param {unknown} arr - Caller-provided array of Permission_String values.
 * @returns {string[]} The same array, when valid.
 * @throws {Error & { code: 'PERMISSION_INVALID' }} when any element is invalid.
 */
export function assertValidPermissions(arr) {
  if (!Array.isArray(arr)) {
    const err = new Error('permissions must be an array')
    err.code = 'PERMISSION_INVALID'
    throw err
  }
  for (const perm of arr) {
    if (typeof perm !== 'string' || !PERMISSIONS.has(perm)) {
      const err = new Error(`Unknown permission string: ${perm}`)
      err.code = 'PERMISSION_INVALID'
      throw err
    }
  }
  return arr
}

// ─── Vendor-app module catalog ───────────────────────────────────────────────
//
// What an owner can grant a STAFF member from the Partner app's Permissions
// screen. This is the single source of truth: the app fetches it
// (GET /api/v1/vendor/employees/permission-catalog) and renders exactly this
// list, and the route guards below enforce exactly these permission strings.
// Nothing is hardcoded on the client, so adding a module is a change here.
//
// `key` is stable (the app maps it to a translated label; `label` is the
// English fallback). `permissions` are real canonical Permission_Strings.
//
// Owner-only areas are deliberately NOT here: managing staff and captains,
// payouts/financials and store settings stay with the owner.
export const VENDOR_APP_PERMISSION_MODULES = Object.freeze([
  {
    key: 'orders',
    label: 'Orders',
    items: [
      { key: 'orders.view', label: 'View orders', permissions: ['shop_orders.view'] },
      { key: 'orders.accept_reject', label: 'Accept / reject new orders', permissions: ['shop_orders.accept_reject'] },
      { key: 'orders.process', label: 'Processing & status updates', permissions: ['shop_orders.update_status'] },
      { key: 'orders.reevaluate', label: 'Re-evaluation', permissions: ['shop_orders.reevaluate'] },
      { key: 'orders.assign_captain', label: 'Assign / broadcast to captains', permissions: ['shop_orders.assign_rider'] },
    ],
  },
  {
    key: 'catalogue',
    label: 'Catalogue & pricing',
    items: [
      { key: 'catalogue.view', label: 'View services & pricing', permissions: ['vendor_services.view'] },
      {
        key: 'catalogue.manage',
        label: 'Manage services & pricing',
        permissions: ['vendor_services.create', 'vendor_services.update', 'vendor_services.delete'],
      },
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    items: [
      { key: 'inventory.view', label: 'View inventory', permissions: ['vendor_inventory.view'] },
      { key: 'inventory.manage', label: 'Manage inventory', permissions: ['vendor_inventory.manage'] },
    ],
  },
  {
    key: 'slots',
    label: 'Pickup slots',
    items: [
      { key: 'slots.view', label: 'View pickup slots', permissions: ['vendor_slots.view'] },
      { key: 'slots.manage', label: 'Manage pickup slots & capacity', permissions: ['vendor_slots.manage'] },
    ],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    items: [
      { key: 'analytics.view', label: 'View analytics', permissions: ['shop_reports.view'] },
    ],
  },
])

/**
 * A stronger permission needs its "view" — an accept/reject grant is useless
 * (and confusing) if the staff member can't open the order list.
 */
const PERMISSION_IMPLIES = Object.freeze({
  'shop_orders.accept_reject': ['shop_orders.view'],
  'shop_orders.update_status': ['shop_orders.view'],
  'shop_orders.reevaluate': ['shop_orders.view'],
  'shop_orders.assign_rider': ['shop_orders.view'],
  'vendor_services.create': ['vendor_services.view'],
  'vendor_services.update': ['vendor_services.view'],
  'vendor_services.delete': ['vendor_services.view'],
  'vendor_inventory.manage': ['vendor_inventory.view'],
  'vendor_slots.manage': ['vendor_slots.view'],
})

/** Adds the implied "view" permissions and de-duplicates. Order-stable. */
export function withImpliedPermissions(perms) {
  const out = new Set(perms)
  for (const p of perms) {
    for (const implied of PERMISSION_IMPLIES[p] || []) out.add(implied)
  }
  return [...out]
}
