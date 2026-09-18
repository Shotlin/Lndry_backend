import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorCashShiftsRepository } from './vendor-cash-shifts.repository.js'

export class VendorCashShiftsService {
  constructor(repository = new VendorCashShiftsRepository()) {
    this.repo = repository
  }

  async _withLiveTotals(vendorId, shift) {
    if (!shift) return null
    const movements = await this.repo.movements(vendorId, shift.register, shift.openedAt, shift.closedAt)
    const expectedCashPaise = shift.status === 'CLOSED'
      ? shift.expectedCashPaise
      : shift.openingCashPaise + movements.collectionsPaise - movements.expensesPaise
    return {
      ...shift,
      collectionsPaise: movements.collectionsPaise,
      expensesPaise: movements.expensesPaise,
      collectionCount: movements.collectionCount,
      expenseCount: movements.expenseCount,
      expectedCashPaise,
    }
  }

  async getCurrent(vendorId, register = 'Main counter') {
    const shift = await this.repo.findOpen(vendorId, register)
    return this._withLiveTotals(vendorId, shift)
  }

  async list(vendorId, pagination) {
    const { shifts, total } = await this.repo.list(vendorId, pagination)
    return { shifts, total }
  }

  async open(vendorId, actor, input) {
    const register = String(input.register || 'Main counter').trim().slice(0, 80) || 'Main counter'
    if (input.openingCashPaise === undefined || input.openingCashPaise === null || input.openingCashPaise < 0) {
      return { success: false, message: 'openingCashPaise is required and must be zero or more' }
    }
    const existing = await this.repo.findOpen(vendorId, register)
    if (existing) {
      return { success: false, message: `A cash shift is already open for register '${register}'`, code: 'SHIFT_ALREADY_OPEN' }
    }
    const shift = await this.repo.open(vendorId, {
      register,
      openingCashPaise: Math.round(input.openingCashPaise),
      note: input.note ? String(input.note).trim().slice(0, 500) : null,
      openedBy: actor.userId,
    })
    emitAudit('vendor_cash_shift_opened', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_cash_shift', target_id: shift.id,
      before: null, after: shift, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, shift: await this._withLiveTotals(vendorId, shift) }
  }

  async close(vendorId, actor, id, input) {
    const shift = await this.repo.findById(vendorId, id)
    if (!shift) return { success: false, message: 'Cash shift not found', code: 'NOT_FOUND' }
    if (shift.status !== 'OPEN') return { success: false, message: 'This cash shift is already closed', code: 'SHIFT_ALREADY_CLOSED' }
    if (input.countedCashPaise === undefined || input.countedCashPaise === null || input.countedCashPaise < 0) {
      return { success: false, message: 'countedCashPaise is required and must be zero or more' }
    }
    const live = await this._withLiveTotals(vendorId, shift)
    const countedCashPaise = Math.round(input.countedCashPaise)
    const variancePaise = countedCashPaise - live.expectedCashPaise
    if (variancePaise !== 0) {
      if (!input.supervisorApproved || !String(input.supervisorActor || '').trim()) {
        return { success: false, message: 'A non-zero cash variance requires supervisor approval', code: 'VARIANCE_APPROVAL_REQUIRED' }
      }
      if (!String(input.note || '').trim()) {
        return { success: false, message: 'A variance explanation is required before supervisor approval', code: 'VARIANCE_NOTE_REQUIRED' }
      }
    }
    const closed = await this.repo.close(id, {
      countedCashPaise,
      expectedCashPaise: live.expectedCashPaise,
      variancePaise,
      varianceApprovedBy: variancePaise !== 0 ? String(input.supervisorActor).trim().slice(0, 160) : null,
      closeNote: input.note ? String(input.note).trim().slice(0, 500) : null,
      closedBy: actor.userId,
    })
    emitAudit('vendor_cash_shift_closed', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_cash_shift', target_id: id,
      before: shift, after: closed, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, shift: closed }
  }
}
