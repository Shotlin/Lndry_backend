import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorAttendanceRepository } from './vendor-attendance.repository.js'

const STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY']
const DATE = /^\d{4}-\d{2}-\d{2}$/

export class VendorAttendanceService {
  constructor(repository = new VendorAttendanceRepository()) {
    this.repo = repository
  }

  async mark(vendorId, actor, input) {
    if (!input.employeeId) return { success: false, message: 'employeeId is required' }
    if (!DATE.test(input.date || '')) return { success: false, message: 'date must be YYYY-MM-DD' }
    if (!STATUSES.includes(input.status)) return { success: false, message: `status must be one of: ${STATUSES.join(', ')}` }
    const existing = await this.repo.findMark(input.employeeId, input.date)
    if (existing) {
      if (existing.status === input.status) return { success: true, duplicate: true, mark: existing }
      return { success: false, message: 'Attendance for this employee and date is already marked with a different status', code: 'ALREADY_MARKED' }
    }
    const mark = await this.repo.mark(vendorId, actor.userId, input)
    emitAudit('vendor_attendance_marked', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_employee_attendance', target_id: mark.id,
      before: null, after: mark, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, duplicate: false, mark }
  }

  async roster(vendorId, date) {
    const roster = await this.repo.roster(vendorId, date)
    const statusCounts = { PRESENT: 0, ABSENT: 0, HALF_DAY: 0, ON_LEAVE: 0, HOLIDAY: 0, UNMARKED: 0 }
    for (const employee of roster) statusCounts[employee.status] = (statusCounts[employee.status] || 0) + 1
    return { date, activeEmployees: roster.length, marked: roster.filter((e) => e.status !== 'UNMARKED').length, statusCounts, roster }
  }
}
