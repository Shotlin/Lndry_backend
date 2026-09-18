import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, employee_id, attendance_date, status, shift, in_time, out_time, working_hours, note, marked_by, created_at`

/**
 * Vendor Attendance repository — ported from epic-laundry-desktop's
 * management.ts#markLaundryAttendance/laundryWorkforceDashboard, backed by
 * this backend's real vendor_employees roster instead of epic's local one.
 */
export class VendorAttendanceRepository {
  async findMark(employeeId, date) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_employee_attendance WHERE employee_id = $1 AND attendance_date = $2`, [employeeId, date])
    return rows[0] ? this._format(rows[0]) : null
  }

  async mark(vendorId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_employee_attendance (vendor_id, employee_id, attendance_date, status, shift, in_time, out_time, working_hours, note, marked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
      [vendorId, input.employeeId, input.date, input.status, input.shift || null, input.inTime || null, input.outTime || null, input.workingHours ?? null, input.note || null, actorUserId]
    )
    return this._format(rows[0])
  }

  async roster(vendorId, date) {
    const { rows } = await query(
      `SELECT ve.id, u.name, ve.role, a.status, a.shift, a.in_time, a.out_time, a.working_hours
       FROM vendor_employees ve
       JOIN users u ON u.id = ve.user_id
       LEFT JOIN vendor_employee_attendance a ON a.employee_id = ve.id AND a.attendance_date = $2
       WHERE ve.vendor_id = $1 AND ve.is_active = true
       ORDER BY u.name ASC`,
      [vendorId, date]
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      status: row.status || 'UNMARKED',
      shift: row.shift,
      inTime: row.in_time,
      outTime: row.out_time,
      workingHours: row.working_hours,
    }))
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, employeeId: row.employee_id, date: row.attendance_date, status: row.status,
      shift: row.shift, inTime: row.in_time, outTime: row.out_time, workingHours: row.working_hours, note: row.note,
      markedBy: row.marked_by, createdAt: row.created_at,
    }
  }
}
