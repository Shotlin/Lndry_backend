import { logger } from '../../../config/logger.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { ReconciliationProblemTypesRepository } from './reconciliation-problem-types.repository.js'

/**
 * Reconciliation Problem Types service. Purely a labeled-reason library —
 * see migration 108_reconciliation_problem_types.sql for why this never
 * touches pricing directly (the vendor's existing confirmed_quantity /
 * new_garment_type_id controls on the reconcile request still do that).
 */
export class ReconciliationProblemTypesService {
  constructor(repository = new ReconciliationProblemTypesRepository()) {
    this.repo = repository
  }

  async listAll() {
    return this.repo.findAll()
  }

  /** What a vendor's reconcile sheet fetches to populate its problem picker. */
  async listActive() {
    return this.repo.findAllActive()
  }

  async create(data, actor) {
    if (!data.label || !data.label.trim()) {
      return { success: false, message: 'label is required' }
    }
    const problemType = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('reconciliation_problem_type_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'reconciliation_problem_type',
      target_id: problemType.id,
      before: null,
      after: problemType,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ problemTypeId: problemType.id, actor: actor.userId }, 'Reconciliation problem type created')
    return { success: true, problemType }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Problem type not found' }
    const problemType = await this.repo.update(id, data)
    emitAudit('reconciliation_problem_type_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'reconciliation_problem_type',
      target_id: id,
      before: existing,
      after: problemType,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, problemType }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Problem type not found' }
    try {
      await this.repo.delete(id)
    } catch (err) {
      // FK from order_reconciliation_problems.problem_type_id (no ON DELETE
      // clause — past reconciliation records must keep pointing at a real
      // row) — a type that's already been used can't be deleted outright.
      if (err.code === '23503') {
        return { success: false, message: 'This problem type has already been used on a real order and can\'t be deleted — deactivate it instead so vendors stop seeing it.' }
      }
      throw err
    }
    emitAudit('reconciliation_problem_type_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'reconciliation_problem_type',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }
}
