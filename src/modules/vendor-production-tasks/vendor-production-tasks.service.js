import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorProductionTasksRepository } from './vendor-production-tasks.repository.js'

/**
 * Vendor Production Tasks service. `onGarmentUnitTransitioned` is called
 * directly by vendor-garment-units' scan() (see that module) — it completes
 * any open task for the unit and, if the new state maps to a station,
 * creates the next one. This mirrors epic's completeOpenTask +
 * createProductionTask both being called inline from scanLaundryGarment.
 */
export class VendorProductionTasksService {
  constructor(repository = new VendorProductionTasksRepository()) {
    this.repo = repository
  }

  async onGarmentUnitTransitioned(vendorId, actorUserId, { garmentUnitId, orderId, nextState, note }) {
    await this.repo.completeOpenForUnit(garmentUnitId, actorUserId, nextState, note)
    if (VendorProductionTasksRepository.stationForState(nextState)) {
      await this.repo.create(vendorId, actorUserId, { garmentUnitId, orderId, state: nextState, reason: note })
    }
  }

  async list(vendorId, query) {
    return this.repo.list(vendorId, query)
  }

  async assign(vendorId, actor, id, employeeId) {
    const task = await this.repo.findById(vendorId, id)
    if (!task) return { success: false, message: 'Production task not found', code: 'NOT_FOUND' }
    if (!['OPEN', 'IN_PROGRESS'].includes(task.status)) return { success: false, message: 'Completed production tasks cannot be assigned' }
    const updated = await this.repo.assign(id, employeeId)
    emitAudit('vendor_production_task_assigned', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_production_task', target_id: id,
      before: task, after: updated, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, task: updated }
  }

  async start(vendorId, actor, id) {
    const task = await this.repo.findById(vendorId, id)
    if (!task) return { success: false, message: 'Production task not found', code: 'NOT_FOUND' }
    if (task.status !== 'OPEN') return { success: false, message: 'Only open production tasks can be started' }
    const updated = await this.repo.start(id, actor.userId)
    emitAudit('vendor_production_task_started', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_production_task', target_id: id,
      before: task, after: updated, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, task: updated }
  }
}
