import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorAdjustmentRulesRepository } from './vendor-adjustment-rules.repository.js'

function validate(input) {
  const name = String(input.name || '').trim()
  if (name.length < 2) return 'name is required'
  if (!['FLAT', 'PERCENTAGE'].includes(input.type)) return 'type must be FLAT or PERCENTAGE'
  if (input.type === 'FLAT') {
    if (!Number.isFinite(Number(input.flatAmountPaise)) || Number(input.flatAmountPaise) < 0) return 'flatAmountPaise must be zero or more'
  } else if (!Number.isFinite(Number(input.percentageBps)) || Number(input.percentageBps) < 0 || Number(input.percentageBps) > 10000) {
    return 'percentageBps must be between 0 and 10000'
  }
  return null
}

/** Computes a rule's amount against a base value — mirrors epic's amountForRule(). Reused by Tier 3's counter-sale quote once it exists. */
export function amountForRule(rule, basePaise) {
  return rule.type === 'PERCENTAGE' ? Math.round((basePaise * rule.percentageBps) / 10000) : rule.flatAmountPaise
}

export class VendorAdjustmentRulesService {
  constructor(repository = new VendorAdjustmentRulesRepository()) {
    this.repo = repository
  }

  async list(vendorId, kind, includeInactive) {
    return this.repo.list(vendorId, kind, includeInactive)
  }

  async create(vendorId, actor, kind, input) {
    const validationError = validate(input)
    if (validationError) return { success: false, message: validationError }
    const name = String(input.name).trim()
    const rule = await this.repo.create(vendorId, { ...input, kind, name })
    emitAudit('vendor_adjustment_rule_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_adjustment_rule', target_id: rule.id,
      before: null, after: rule, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }

  async update(vendorId, actor, id, input) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Adjustment rule not found', code: 'NOT_FOUND' }
    const validationError = validate(input)
    if (validationError) return { success: false, message: validationError }
    const rule = await this.repo.update(id, { ...input, name: String(input.name).trim() })
    emitAudit('vendor_adjustment_rule_updated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_adjustment_rule', target_id: id,
      before: existing, after: rule, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }
}
