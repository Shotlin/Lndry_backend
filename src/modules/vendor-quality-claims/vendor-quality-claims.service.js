import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorQualityClaimsRepository } from './vendor-quality-claims.repository.js'
import { VendorGarmentUnitsService } from '../vendor-garment-units/vendor-garment-units.service.js'
import { VendorGarmentUnitsRepository } from '../vendor-garment-units/vendor-garment-units.repository.js'

const CATEGORIES = ['STAIN', 'DAMAGE', 'MISSING', 'REWASH', 'OTHER']
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const DECISIONS = ['REWASH', 'DAMAGED', 'MISSING', 'RELEASE', 'REJECT']
const GARMENT_DRIVING_DECISIONS = new Set(['REWASH', 'DAMAGED', 'MISSING'])

/**
 * Vendor Quality Claims service — ported from epic-laundry-desktop's
 * quality.ts. resolve() reuses VendorGarmentUnitsService.scan() to actually
 * move the garment for a Rewash/Damaged/Missing decision, exactly like
 * epic's resolveQualityClaim calls its own scanLaundryGarment.
 */
export class VendorQualityClaimsService {
  constructor(
    repository = new VendorQualityClaimsRepository(),
    garmentUnitsRepo = new VendorGarmentUnitsRepository(),
    garmentUnitsService = new VendorGarmentUnitsService()
  ) {
    this.repo = repository
    this.garmentUnitsRepo = garmentUnitsRepo
    this.garmentUnits = garmentUnitsService
  }

  async open(vendorId, actor, input) {
    const unit = await this.garmentUnitsRepo.findById(vendorId, input.garmentUnitId)
    if (!unit) return { success: false, message: 'Garment unit not found', code: 'NOT_FOUND' }
    if (!CATEGORIES.includes(input.category)) return { success: false, message: `category must be one of: ${CATEGORIES.join(', ')}` }
    const severity = input.severity || 'MEDIUM'
    if (!SEVERITIES.includes(severity)) return { success: false, message: `severity must be one of: ${SEVERITIES.join(', ')}` }
    const description = String(input.description || '').trim().slice(0, 1000)
    if (description.length < 3) return { success: false, message: 'description is required' }
    const existing = await this.repo.findOpenForUnit(unit.id)
    if (existing) return { success: false, message: 'This garment already has an open quality claim', code: 'ALREADY_OPEN' }

    const claim = await this.repo.create(vendorId, actor.userId, { garmentUnitId: unit.id, orderId: unit.orderId, category: input.category, severity, description })
    emitAudit('vendor_quality_claim_opened', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_quality_claim', target_id: claim.id,
      before: null, after: claim, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, claim }
  }

  async resolve(vendorId, actor, id, decision, note) {
    const claim = await this.repo.findById(vendorId, id)
    if (!claim) return { success: false, message: 'Quality claim not found', code: 'NOT_FOUND' }
    if (!['OPEN', 'UNDER_REVIEW'].includes(claim.status)) return { success: false, message: 'Quality claim is already closed' }
    if (!DECISIONS.includes(decision)) return { success: false, message: `decision must be one of: ${DECISIONS.join(', ')}` }
    const resolutionNote = String(note || '').trim().slice(0, 1000)
    if (resolutionNote.length < 3) return { success: false, message: 'A resolution note is required' }

    const unit = await this.garmentUnitsRepo.findById(vendorId, claim.garmentUnitId)
    if (!unit) return { success: false, message: 'Garment unit not found', code: 'NOT_FOUND' }

    if (GARMENT_DRIVING_DECISIONS.has(decision)) {
      const scanResult = await this.garmentUnits.scan(vendorId, actor, { tagCode: unit.activeTagCode, nextState: decision, note: resolutionNote })
      if (!scanResult.success) return { success: false, message: `Could not move garment to ${decision}: ${scanResult.message}` }
    }

    const resolved = await this.repo.resolve(id, actor.userId, decision, resolutionNote)
    const correction = await this.repo.issueCorrection(id, actor.userId, { customerUserId: unit.customerUserId, orderId: unit.orderId, garmentUnitId: unit.id, decision })
    emitAudit('vendor_quality_claim_resolved', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_quality_claim', target_id: id,
      before: claim, after: resolved, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, claim: resolved, correction }
  }

  async list(vendorId, query) {
    return this.repo.list(vendorId, query)
  }

  async getDetail(vendorId, id) {
    const claim = await this.repo.findById(vendorId, id)
    if (!claim) return null
    return { ...claim, correction: await this.repo.correctionForClaim(id) }
  }

  async correctionsForOrder(vendorId, orderId) {
    return this.repo.correctionsForOrder(orderId)
  }
}
