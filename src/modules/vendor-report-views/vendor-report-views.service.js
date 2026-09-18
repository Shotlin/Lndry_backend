import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorReportViewsRepository } from './vendor-report-views.repository.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/

export class VendorReportViewsService {
  constructor(repository = new VendorReportViewsRepository()) {
    this.repo = repository
  }

  async list(vendorId, ownerId) {
    return this.repo.listForOwner(vendorId, ownerId)
  }

  async create(vendorId, actor, input, canShare) {
    const viewName = String(input.viewName || '').trim()
    if (viewName.length < 2) return { success: false, message: 'viewName is required' }
    const reportKind = String(input.reportKind || '').trim()
    if (!reportKind) return { success: false, message: 'reportKind is required' }
    if (input.fromDate && !DATE.test(input.fromDate)) return { success: false, message: 'fromDate must be YYYY-MM-DD' }
    if (input.toDate && !DATE.test(input.toDate)) return { success: false, message: 'toDate must be YYYY-MM-DD' }
    if (input.fromDate && input.toDate && input.fromDate > input.toDate) return { success: false, message: 'fromDate must not be after toDate' }
    const shared = Boolean(input.shared) && canShare
    const view = await this.repo.create(vendorId, actor.userId, { ...input, viewName, reportKind, shared })
    emitAudit('vendor_report_view_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_report_saved_view', target_id: view.id,
      before: null, after: view, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, view }
  }

  async delete(actor, id) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Saved view not found', code: 'NOT_FOUND' }
    if (existing.ownerId !== actor.userId) return { success: false, message: 'Only the saved view owner can delete it', code: 'FORBIDDEN' }
    const view = await this.repo.deactivate(id)
    emitAudit('vendor_report_view_deleted', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_report_saved_view', target_id: id,
      before: existing, after: view, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, view }
  }
}
