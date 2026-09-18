import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorPrintJobsRepository } from './vendor-print-jobs.repository.js'

export class VendorPrintJobsService {
  constructor(repository = new VendorPrintJobsRepository()) {
    this.repo = repository
  }

  async create(vendorId, actor, input) {
    if (!input.orderId) return { success: false, message: 'orderId is required' }
    const hasTargets = (input.garmentUnitIds?.length || 0) > 0 || (input.containerIds?.length || 0) > 0
    if (!hasTargets) return { success: false, message: 'At least one garmentUnitId or containerId is required' }
    const job = await this.repo.create(vendorId, actor.userId, input)
    emitAudit('vendor_print_job_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_print_job', target_id: job.id,
      before: null, after: job, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, job }
  }

  async markStatus(vendorId, actor, id, status, failureReason) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Print job not found', code: 'NOT_FOUND' }
    if (!['PENDING', 'PRINTED', 'FAILED'].includes(status)) return { success: false, message: 'Invalid status' }
    const job = await this.repo.updateStatus(id, status, failureReason)
    emitAudit('vendor_print_job_status_updated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_print_job', target_id: id,
      before: existing, after: job, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, job }
  }

  async listForOrder(vendorId, orderId) {
    return this.repo.listForOrder(vendorId, orderId)
  }
}
