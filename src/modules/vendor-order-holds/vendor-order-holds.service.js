import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorOrderHoldsRepository } from './vendor-order-holds.repository.js'

const LEASE_MINUTES = 15
const LEASE_MS = LEASE_MINUTES * 60 * 1000

/**
 * Vendor Order Holds service — ported from epic-laundry-desktop's holds.ts.
 * `ownership` is a derived view, not a stored field: 'mine' / 'other' /
 * 'expired' / 'unassigned', computed from ownership_updated_at + the fixed
 * 15-minute lease, same as epic's listLaundryOrderHolds.
 */
export class VendorOrderHoldsService {
  constructor(repository = new VendorOrderHoldsRepository()) {
    this.repo = repository
  }

  _present(hold, actorUserId) {
    const ownershipAt = hold.ownershipUpdatedAt ? Date.parse(hold.ownershipUpdatedAt) : NaN
    const leaseExpiresAt = hold.ownerUserId && Number.isFinite(ownershipAt) ? new Date(ownershipAt + LEASE_MS).toISOString() : undefined
    const expired = Boolean(leaseExpiresAt && Date.parse(leaseExpiresAt) <= Date.now())
    const ownership = !hold.ownerUserId ? 'unassigned' : expired ? 'expired' : hold.ownerUserId === actorUserId ? 'mine' : 'other'
    return { ...hold, leaseExpiresAt, ownership }
  }

  _isHeldByOther(hold, actorUserId) {
    const presented = this._present(hold, actorUserId)
    return presented.ownership === 'other'
  }

  async create(vendorId, actor, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { success: false, message: 'payload must be an object' }
    if (!payload.lines || !Array.isArray(payload.lines) || payload.lines.length === 0) return { success: false, message: 'payload requires at least one cart line' }
    const hold = await this.repo.create(vendorId, actor.userId, payload)
    emitAudit('vendor_order_hold_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_order_hold', target_id: hold.id,
      before: null, after: { holdCode: hold.holdCode }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, hold: this._present(hold, actor.userId) }
  }

  async list(vendorId, actorUserId, includeClosed) {
    const holds = await this.repo.list(vendorId, includeClosed)
    return holds.map((hold) => this._present(hold, actorUserId))
  }

  async presence(vendorId, actorUserId) {
    const holds = await this.list(vendorId, actorUserId, false)
    return {
      observedAt: new Date().toISOString(), leaseMinutes: LEASE_MINUTES, totalHeld: holds.length,
      mineActive: holds.filter((h) => h.ownership === 'mine').length,
      otherActive: holds.filter((h) => h.ownership === 'other').length,
      expired: holds.filter((h) => h.ownership === 'expired').length,
      unassigned: holds.filter((h) => h.ownership === 'unassigned').length,
      staleHoldCodes: holds.filter((h) => h.ownership === 'expired').slice(0, 50).map((h) => h.holdCode),
    }
  }

  async claim(vendorId, actor, id) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Order hold not found', code: 'NOT_FOUND' }
    if (existing.status !== 'HELD') return { success: false, message: `Order hold is already ${existing.status.toLowerCase()}` }
    const hold = await this.repo.claim(id, actor.userId)
    emitAudit('vendor_order_hold_claimed', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_order_hold', target_id: id,
      before: existing, after: hold, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, hold: this._present(hold, actor.userId) }
  }

  async renew(vendorId, actor, id) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Order hold not found', code: 'NOT_FOUND' }
    if (existing.ownerUserId !== actor.userId) return { success: false, message: 'Only the current holder can renew this lease' }
    const hold = await this.repo.renew(id, actor.userId)
    return { success: true, hold: this._present(hold, actor.userId) }
  }

  async release(vendorId, actor, id, override) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Order hold not found', code: 'NOT_FOUND' }
    if (this._isHeldByOther(existing, actor.userId) && !override) return { success: false, message: 'Order hold is owned by another counter; claim it before releasing' }
    const hold = await this.repo.release(id)
    emitAudit('vendor_order_hold_released', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_order_hold', target_id: id,
      before: existing, after: hold, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, hold: this._present(hold, actor.userId) }
  }

  async resume(vendorId, actor, id, override) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Order hold not found', code: 'NOT_FOUND' }
    if (existing.status !== 'HELD') return { success: false, message: `Order hold is already ${existing.status.toLowerCase()}` }
    if (this._isHeldByOther(existing, actor.userId) && !override) return { success: false, message: 'Order hold is owned by another counter; claim it before resuming' }
    const hold = await this.repo.resume(id, actor.userId)
    emitAudit('vendor_order_hold_resumed', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_order_hold', target_id: id,
      before: existing, after: hold, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, hold: this._present(hold, actor.userId) }
  }

  async cancel(vendorId, actor, id, override) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Order hold not found', code: 'NOT_FOUND' }
    if (existing.status !== 'HELD') return { success: false, message: `Order hold is already ${existing.status.toLowerCase()}` }
    if (this._isHeldByOther(existing, actor.userId) && !override) return { success: false, message: 'Order hold is owned by another counter; claim it before cancelling' }
    const hold = await this.repo.cancel(id, actor.userId)
    emitAudit('vendor_order_hold_cancelled', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_order_hold', target_id: id,
      before: existing, after: hold, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, hold: this._present(hold, actor.userId) }
  }
}
