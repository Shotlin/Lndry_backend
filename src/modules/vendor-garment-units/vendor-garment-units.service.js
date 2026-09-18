import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorGarmentUnitsRepository } from './vendor-garment-units.repository.js'

const GARMENT_UNIT_STATES = ['INTAKE', 'SORTED', 'PROCESSING', 'QC', 'REWASH', 'ASSEMBLY', 'RACKED', 'DISPATCHED', 'DELIVERED', 'MISSING', 'DAMAGED', 'CANCELLED']
const PIECE_UNITS = new Set(['piece', 'pair', 'pc', 'pcs'])
const REASON_REQUIRED_STATES = new Set(['REWASH', 'MISSING', 'DAMAGED'])

/**
 * Vendor Garment Units service — generate/scan/reprint/replace, ported from
 * epic-laundry-desktop's domain.ts. See TagRetiredError-equivalent handling
 * in scan(): a retired tag returns a structured 'TAG_RETIRED' result instead
 * of throwing, same information epic's TagRetiredError carries.
 */
export class VendorGarmentUnitsService {
  constructor(repository = new VendorGarmentUnitsRepository()) {
    this.repo = repository
  }

  async generate(vendorId, actor, input) {
    const line = await this.repo.findOrderLine(vendorId, input.orderLineId)
    if (!line) return { success: false, message: 'Order line not found for this vendor', code: 'NOT_FOUND' }
    if (!PIECE_UNITS.has(String(line.unit || '').toLowerCase())) {
      return { success: false, message: `This line is billed by ${line.unit || 'weight'}, not by piece — use the bag/container tagging endpoint instead`, code: 'NOT_PIECE_BASED' }
    }
    const already = await this.repo.existingSequenceCount(line.id)
    const requestedCount = input.count === undefined ? (line.confirmed_quantity ?? line.estimated_quantity) : Math.trunc(Number(input.count))
    if (!Number.isFinite(requestedCount) || requestedCount <= 0) return { success: false, message: 'A positive garment count is required' }
    if (already > 0) return { success: false, message: `${already} tag(s) already exist for this order line`, code: 'ALREADY_GENERATED' }
    if (requestedCount > 500) return { success: false, message: 'Cannot generate more than 500 tags at once' }

    const units = await this.repo.createBatch(vendorId, actor.userId, line.order_id, line.id, line.customer_user_id, line.garment_type_id, requestedCount, 1)
    emitAudit('vendor_garment_units_generated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'order_line', target_id: line.id,
      before: null, after: { count: units.length, orderId: line.order_id }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, units }
  }

  async listForOrder(vendorId, orderId) {
    return this.repo.listForOrder(vendorId, orderId)
  }

  async getDetail(vendorId, id) {
    const unit = await this.repo.findById(vendorId, id)
    if (!unit) return null
    const [events, tagHistory] = await Promise.all([this.repo.eventsFor(id), this.repo.tagHistoryFor(id)])
    return { ...unit, events, tagHistory }
  }

  async scan(vendorId, actor, input) {
    const tagCode = String(input.tagCode || '').trim()
    if (!tagCode || tagCode.length > 40) return { success: false, message: 'Scan a garment tag code' }

    const unit = await this.repo.findByTag(vendorId, tagCode)
    if (!unit) {
      const retired = await this.repo.findRetiredTag(vendorId, tagCode)
      if (retired) {
        return {
          success: false, code: 'TAG_RETIRED', message: 'This tag has been replaced. Scan the current active tag to continue.',
          details: { tagCode, garmentUnitId: retired.unit_id, replacementTagId: retired.replacement_tag_id, replacementDate: retired.retired_at, replacementOperator: retired.retired_by },
        }
      }
      return { success: false, message: 'Garment tag was not found', code: 'TAG_NOT_FOUND' }
    }

    const nextState = input.nextState ? String(input.nextState).toUpperCase() : undefined
    const alreadyAtStage = Boolean(nextState && nextState === unit.state)
    if (nextState !== undefined && !GARMENT_UNIT_STATES.includes(nextState)) return { success: false, message: 'Unknown garment state', code: 'INVALID_GARMENT_TRANSITION' }
    const location = String(input.location || unit.location || '').trim().slice(0, 80) || unit.location
    const note = String(input.note || '').trim().slice(0, 500)
    const condition = String(input.condition || unit.condition || 'Normal').trim().slice(0, 40) || 'Normal'

    if (nextState && REASON_REQUIRED_STATES.has(nextState) && note.length < 3) {
      return { success: false, message: `${nextState} requires an operator reason` }
    }
    if (nextState && nextState !== unit.state && !VendorGarmentUnitsRepository.TRANSITIONS[unit.state]?.includes(nextState)) {
      return { success: false, message: `Cannot move a garment from ${unit.state} to ${nextState}`, code: 'INVALID_GARMENT_TRANSITION' }
    }

    const effectiveState = nextState || unit.state
    if (effectiveState === 'RACKED' && await this.repo.isRackLocationTaken(vendorId, location, unit.id)) {
      return { success: false, message: `Rack location ${location} is already occupied by another garment` }
    }

    if (nextState && nextState !== unit.state) {
      const fromState = unit.state
      await this.repo.transition(unit.id, { state: nextState, location, condition })
      await this.repo.appendEvent(unit.id, { eventType: 'STATE_TRANSITION', fromState, toState: nextState, location, note, actorId: actor.userId })
      emitAudit('vendor_garment_unit_scanned', {
        actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_garment_unit', target_id: unit.id,
        before: { state: fromState, location: unit.location }, after: { state: nextState, location, tagCode },
        ip_address: actor.ip, user_agent: actor.userAgent,
      })
      return { success: true, unit: await this.getDetail(vendorId, unit.id), scanResult: 'accepted' }
    }

    await this.repo.touch(unit.id, { location, condition })
    await this.repo.appendEvent(unit.id, { eventType: 'SCAN', location, note, actorId: actor.userId })
    return { success: true, unit: await this.getDetail(vendorId, unit.id), scanResult: alreadyAtStage ? 'already_at_stage' : 'accepted' }
  }

  async reprintTag(vendorId, actor, id, input) {
    const unit = await this.repo.findById(vendorId, id)
    if (!unit) return { success: false, message: 'Garment unit not found', code: 'NOT_FOUND' }
    const reason = String(input.reason || '').trim().slice(0, 240)
    if (reason.length < 3) return { success: false, message: 'A reprint reason is required' }
    await this.repo.appendEvent(unit.id, { eventType: 'TAG_REPRINTED', location: unit.location, note: reason, actorId: actor.userId })
    emitAudit('vendor_garment_tag_reprinted', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_garment_unit', target_id: unit.id,
      before: null, after: { tagCode: unit.activeTagCode, reason }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, unit: await this.getDetail(vendorId, unit.id) }
  }

  async replaceTag(vendorId, actor, id, input) {
    const unit = await this.repo.findById(vendorId, id)
    if (!unit) return { success: false, message: 'Garment unit not found', code: 'NOT_FOUND' }
    const reason = String(input.reason || '').trim().slice(0, 240)
    if (reason.length < 3) return { success: false, message: 'A replacement reason is required' }
    const tagHistory = await this.repo.tagHistoryFor(unit.id)
    const currentTag = tagHistory.find((t) => t.tagCode === unit.activeTagCode)
    const newTagCode = this.repo.generateTagCode()

    const created = await this.repo.createTagHistory(unit.id, newTagCode, actor.userId)
    if (currentTag) await this.repo.retireTagHistory(currentTag.id, { status: input.status || 'REPLACED', retiredBy: actor.userId, retirementReason: reason, replacementTagId: created.id })
    await this.repo.setActiveTag(unit.id, newTagCode)
    await this.repo.appendEvent(unit.id, { eventType: 'TAG_REPLACED', location: unit.location, note: reason, actorId: actor.userId })
    emitAudit('vendor_garment_tag_replaced', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_garment_unit', target_id: unit.id,
      before: { tagCode: unit.activeTagCode }, after: { tagCode: newTagCode, reason }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, unit: await this.getDetail(vendorId, unit.id) }
  }
}
