import { query } from '../../../config/database.js'
import { DEVICE_COLUMNS, DEVICE_FROM } from '../../notifications/notification-dispatcher.js'
import { buildSegmentWhere } from './notifications.repository.js'

/**
 * Audience = WHO receives a notification, always resolved from the database at
 * send time (never from anything the browser computed). A campaign stores the
 * spec as JSON, so a campaign scheduled for tomorrow still targets exactly
 * what the admin chose today.
 *
 * Spec shapes (`kind` selects one):
 *   { kind: 'ALL_CUSTOMERS' }                       every customer-app device
 *   { kind: 'ALL_VENDORS' }                         vendor owners + staff (Partner app)
 *   { kind: 'ALL_CAPTAINS' }                        captains (Partner app)
 *   { kind: 'USER', userId }                        one person, all their devices
 *   { kind: 'VENDOR', vendorId }                    one vendor's owner + staff
 *   { kind: 'VENDOR_CAPTAINS', vendorId }           one vendor's captains
 *   { kind: 'SEGMENT', segmentId }                  a customer segment
 *   { kind: 'LOCATION', target, city?, pincode? }   customers|vendors|captains in an area
 *   { kind: 'LEGACY', segment, value? }             the pre-existing named segments
 */

export const AUDIENCE_KINDS = [
  'ALL_CUSTOMERS', 'ALL_VENDORS', 'ALL_CAPTAINS', 'USER', 'VENDOR',
  'VENDOR_CAPTAINS', 'SEGMENT', 'LOCATION', 'LEGACY',
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VENDOR_ROLES = "('VENDOR_OWNER','VENDOR_STAFF')"
const LEGACY_SEGMENTS = [
  'all_customers', 'all', 'new', 'inactive_customers', 'inactive',
  'high_value', 'store_customers', 'cart_not_empty',
]

export class AudienceError extends Error {
  constructor(message) { super(message); this.code = 'AUDIENCE_INVALID' }
}

/** Validate and clean a spec. Throws AudienceError with a plain sentence. */
export function normalizeAudience(input) {
  if (!input || typeof input !== 'object') throw new AudienceError('Choose who should receive this notification.')
  const kind = String(input.kind || '').toUpperCase()
  if (!AUDIENCE_KINDS.includes(kind)) throw new AudienceError('Unknown audience.')

  switch (kind) {
    case 'ALL_CUSTOMERS':
    case 'ALL_VENDORS':
    case 'ALL_CAPTAINS':
      return { kind }
    case 'USER':
      if (!UUID.test(input.userId || '')) throw new AudienceError('Pick a specific person from the list.')
      return { kind, userId: input.userId }
    case 'VENDOR':
    case 'VENDOR_CAPTAINS':
      if (!UUID.test(input.vendorId || '')) throw new AudienceError('Pick a vendor from the list.')
      return { kind, vendorId: input.vendorId }
    case 'SEGMENT':
      if (!UUID.test(input.segmentId || '')) throw new AudienceError('Pick a customer segment.')
      return { kind, segmentId: input.segmentId }
    case 'LOCATION': {
      const target = String(input.target || '').toLowerCase()
      if (!['customers', 'vendors', 'captains'].includes(target)) throw new AudienceError('Choose customers, vendors or captains for the area.')
      const city = String(input.city || '').trim()
      const pincode = String(input.pincode || '').trim()
      if (!city && !pincode) throw new AudienceError('Enter a city or a pincode.')
      if (pincode && !/^[0-9A-Za-z -]{3,10}$/.test(pincode)) throw new AudienceError('That pincode does not look right.')
      return { kind, target, ...(city ? { city } : {}), ...(pincode ? { pincode } : {}) }
    }
    case 'LEGACY': {
      const segment = String(input.segment || '')
      if (!LEGACY_SEGMENTS.includes(segment)) throw new AudienceError('Unknown segment.')
      if (['store_customers'].includes(segment) && !input.value) throw new AudienceError('This segment needs a vendor id.')
      return { kind, segment, ...(input.value ? { value: String(input.value) } : {}) }
    }
    default:
      throw new AudienceError('Unknown audience.')
  }
}

/**
 * Turn the pre-existing `{ segment, segmentValue }` request shape into a spec.
 * `specific_user` used to accept a phone number or a user id and — when the
 * value was missing — silently widened to everyone; both are now explicit.
 */
export async function audienceFromLegacy(segment, segmentValue) {
  if (segment === 'specific_user') {
    if (!segmentValue) throw new AudienceError('Enter a phone number or pick a person.')
    const { rows: [u] } = await query(
      `SELECT id FROM users WHERE is_active = true AND (id::text = $1 OR phone = $1) LIMIT 1`,
      [String(segmentValue)]
    )
    if (!u) throw new AudienceError('No active user found for that phone number or id.')
    return { kind: 'USER', userId: u.id }
  }
  return normalizeAudience({ kind: 'LEGACY', segment, value: segmentValue })
}

/** SQL predicate (over `ft`, `u`) and its parameters for a normalized spec. */
export function audiencePredicate(spec) {
  const params = []
  const p = (v) => { params.push(v); return `$${params.length}` }
  const partnerRole = (roles) => `EXISTS (SELECT 1 FROM vendor_employees ve
      WHERE ve.user_id = ft.user_id AND ve.is_active = true AND ve.deleted_at IS NULL
        AND ve.role IN ${roles} %VENDOR%)`

  switch (spec.kind) {
    case 'ALL_CUSTOMERS':
      return { where: `ft.app_type = 'customer'`, params }
    case 'ALL_VENDORS':
      return { where: `ft.app_type = 'partner' AND ${partnerRole(VENDOR_ROLES).replace('%VENDOR%', '')}`, params }
    case 'ALL_CAPTAINS':
      return { where: `ft.app_type = 'partner' AND ${partnerRole("('VENDOR_RIDER')").replace('%VENDOR%', '')}`, params }
    case 'USER':
      return { where: `ft.user_id = ${p(spec.userId)}::uuid`, params }
    case 'VENDOR':
      return {
        where: `ft.app_type = 'partner' AND ${partnerRole(VENDOR_ROLES).replace('%VENDOR%', `AND ve.vendor_id = ${p(spec.vendorId)}::uuid`)}`,
        params,
      }
    case 'VENDOR_CAPTAINS':
      return {
        where: `ft.app_type = 'partner' AND ${partnerRole("('VENDOR_RIDER')").replace('%VENDOR%', `AND ve.vendor_id = ${p(spec.vendorId)}::uuid`)}`,
        params,
      }
    case 'SEGMENT':
      return {
        where: `ft.app_type = 'customer' AND ft.user_id IN (
                  SELECT m.user_id FROM customer_segment_members m WHERE m.segment_id = ${p(spec.segmentId)}::uuid)`,
        params,
      }
    case 'LOCATION': {
      if (spec.target === 'customers') {
        const conds = []
        if (spec.city) conds.push(`lower(a.city) = lower(${p(spec.city)})`)
        if (spec.pincode) conds.push(`a.pincode = ${p(spec.pincode)}`)
        return {
          where: `ft.app_type = 'customer' AND EXISTS (
                    SELECT 1 FROM addresses a WHERE a.user_id = ft.user_id AND ${conds.join(' AND ')})`,
          params,
        }
      }
      const roles = spec.target === 'captains' ? "('VENDOR_RIDER')" : VENDOR_ROLES
      const conds = []
      if (spec.city) conds.push(`lower(v.city) = lower(${p(spec.city)})`)
      if (spec.pincode) conds.push(`v.pincode = ${p(spec.pincode)}`)
      return {
        where: `ft.app_type = 'partner' AND EXISTS (
                  SELECT 1 FROM vendor_employees ve JOIN vendors v ON v.id = ve.vendor_id
                   WHERE ve.user_id = ft.user_id AND ve.is_active = true AND ve.deleted_at IS NULL
                     AND ve.role IN ${roles} AND ${conds.join(' AND ')})`,
        params,
      }
    }
    case 'LEGACY': {
      const seg = buildSegmentWhere(spec.segment, spec.value)
      return {
        where: `ft.app_type = 'customer' AND ft.user_id IN (SELECT u.id FROM users u WHERE ${seg.where})`,
        params: seg.params,
      }
    }
    default:
      throw new AudienceError('Unknown audience.')
  }
}

function deviceSelect(spec) {
  const { where, params } = audiencePredicate(spec)
  return {
    sql: `SELECT ${DEVICE_COLUMNS} ${DEVICE_FROM} WHERE ft.is_active = true AND (${where})`,
    params,
  }
}

/** Live numbers shown to the admin before sending. */
export async function countAudience(spec) {
  const { sql, params } = deviceSelect(spec)
  const { rows: [r] } = await query(
    `SELECT COUNT(DISTINCT d.user_id)::int AS users,
            COUNT(*)::int AS devices,
            COUNT(*) FILTER (WHERE d.app_type = 'customer')::int AS customer_devices,
            COUNT(*) FILTER (WHERE d.app_type = 'partner')::int AS partner_devices,
            COUNT(*) FILTER (WHERE d.platform = 'android')::int AS android_devices,
            COUNT(*) FILTER (WHERE d.platform = 'ios')::int AS ios_devices
       FROM (${sql}) d`,
    params
  )
  return r
}

/** All device rows for a send. Ordered so a user's devices stay together. */
export async function resolveAudienceDevices(spec, { limit = 200000 } = {}) {
  const { sql, params } = deviceSelect(spec)
  const { rows } = await query(
    `SELECT * FROM (${sql}) d ORDER BY d.user_id LIMIT ${Number(limit)}`,
    params
  )
  return rows
}
