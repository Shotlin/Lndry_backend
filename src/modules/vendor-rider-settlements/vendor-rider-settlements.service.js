import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorRiderSettlementsRepository } from './vendor-rider-settlements.repository.js'

const METHODS = ['CASH', 'UPI', 'BANK']
const STATUS_TRANSITIONS = {
  PENDING: ['HANDED_OVER', 'RECONCILED', 'REJECTED'],
  HANDED_OVER: ['RECONCILED', 'REJECTED'],
  RECONCILED: [],
  REJECTED: [],
}

export class VendorRiderSettlementsService {
  constructor(repository = new VendorRiderSettlementsRepository()) {
    this.repo = repository
  }

  async _validateOrders(riderUserId, orderIds) {
    const unique = [...new Set(orderIds.filter(Boolean))]
    if (!unique.length) return { orderIds: unique }
    const assigned = new Set(await this.repo.ordersAssignedToRider(unique, riderUserId))
    const notAssigned = unique.filter((id) => !assigned.has(id))
    if (notAssigned.length) return { error: `These orders are not assigned to this rider: ${notAssigned.join(', ')}` }
    return { orderIds: unique }
  }

  async create(vendorId, actor, input) {
    const rider = await this.repo.findRider(vendorId, input.riderEmployeeId)
    if (!rider) return { success: false, message: 'Active rider not found', code: 'NOT_FOUND' }
    const amountPaise = Math.round(Number(input.amountPaise))
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return { success: false, message: 'amountPaise must be greater than zero' }
    const method = input.method || 'CASH'
    if (!METHODS.includes(method)) return { success: false, message: `method must be one of: ${METHODS.join(', ')}` }
    const { orderIds, error: ordersError } = await this._validateOrders(rider.user_id, input.orderIds || [])
    if (ordersError) return { success: false, message: ordersError }

    const settlement = await this.repo.create(vendorId, actor.userId, {
      riderEmployeeId: rider.id, settlementDate: input.settlementDate || new Date().toISOString().slice(0, 10),
      amountPaise, method, orderIds, reference: input.reference, notes: input.notes,
    })
    emitAudit('vendor_rider_settlement_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_rider_settlement', target_id: settlement.id,
      before: null, after: settlement, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, settlement }
  }

  async update(vendorId, actor, id, input) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Rider settlement not found', code: 'NOT_FOUND' }
    if (['RECONCILED', 'REJECTED'].includes(existing.status)) return { success: false, message: 'Reconciled or rejected settlements are immutable' }
    const rider = await this.repo.findRider(vendorId, existing.riderEmployeeId)
    const amountPaise = input.amountPaise === undefined ? existing.amountPaise : Math.round(Number(input.amountPaise))
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return { success: false, message: 'amountPaise must be greater than zero' }
    const method = input.method || existing.method
    if (!METHODS.includes(method)) return { success: false, message: `method must be one of: ${METHODS.join(', ')}` }
    const { orderIds, error: ordersError } = await this._validateOrders(rider.user_id, input.orderIds ?? existing.orderIds)
    if (ordersError) return { success: false, message: ordersError }

    const settlement = await this.repo.update(id, {
      settlementDate: input.settlementDate || existing.settlementDate, amountPaise, method, orderIds,
      reference: input.reference ?? existing.reference, notes: input.notes ?? existing.notes,
    })
    emitAudit('vendor_rider_settlement_updated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_rider_settlement', target_id: id,
      before: existing, after: settlement, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, settlement }
  }

  async setStatus(vendorId, actor, id, status) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Rider settlement not found', code: 'NOT_FOUND' }
    if (!STATUS_TRANSITIONS[existing.status]?.includes(status)) {
      return { success: false, message: `Cannot move a settlement from ${existing.status} to ${status}` }
    }
    const settlement = await this.repo.updateStatus(id, status)
    emitAudit('vendor_rider_settlement_status_changed', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_rider_settlement', target_id: id,
      before: existing, after: settlement, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, settlement }
  }

  async list(vendorId, query) {
    return this.repo.list(vendorId, query)
  }
}
