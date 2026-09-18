import { query } from '../../config/database.js'

const COLUMNS = `id, vendor_id, garment_unit_id, order_id, station, kind, status, priority, assigned_to, reason, completion_note, output_state, started_at, started_by, completed_at, completed_by, created_at, updated_at`

const STATION_FOR_STATE = {
  INTAKE: 'INTAKE', SORTED: 'SORTING', PROCESSING: 'PROCESSING', QC: 'QUALITY_CONTROL',
  REWASH: 'REWASH', ASSEMBLY: 'ASSEMBLY', RACKED: 'RACK', DISPATCHED: 'DISPATCH',
}
const URGENT_STATES = new Set(['MISSING', 'DAMAGED', 'REWASH'])

/**
 * Vendor Production Tasks repository — floor work queue, ported from
 * epic-laundry-desktop's production.ts. See migration 125.
 */
export class VendorProductionTasksRepository {
  static stationForState(state) {
    return STATION_FOR_STATE[state]
  }

  static isUrgent(state) {
    return URGENT_STATES.has(state)
  }

  async create(vendorId, actorUserId, { garmentUnitId, orderId, state, reason }) {
    const station = STATION_FOR_STATE[state]
    if (!station) return null
    const { rows } = await query(
      `INSERT INTO vendor_production_tasks (vendor_id, garment_unit_id, order_id, station, kind, priority, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [vendorId, garmentUnitId, orderId, station, state, URGENT_STATES.has(state) ? 'URGENT' : 'NORMAL', (reason || '').slice(0, 500)]
    )
    return this._format(rows[0])
  }

  async findOpenForUnit(garmentUnitId) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_production_tasks WHERE garment_unit_id = $1 AND status IN ('OPEN', 'IN_PROGRESS') LIMIT 1`,
      [garmentUnitId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async completeOpenForUnit(garmentUnitId, actorUserId, outputState, note) {
    const { rows } = await query(
      `UPDATE vendor_production_tasks SET status = 'COMPLETED', completed_at = NOW(), completed_by = $2, output_state = $3, completion_note = $4, updated_at = NOW()
       WHERE garment_unit_id = $1 AND status IN ('OPEN', 'IN_PROGRESS') RETURNING ${COLUMNS}`,
      [garmentUnitId, actorUserId, outputState, (note || '').slice(0, 500)]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_production_tasks WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async list(vendorId, { status, station, page = 1, limit = 50 } = {}) {
    const conditions = ['vendor_id = $1']
    const params = [vendorId]
    if (status) { params.push(status); conditions.push(`status = $${params.length}`) }
    if (station) { params.push(station); conditions.push(`station = $${params.length}`) }
    const offset = (page - 1) * limit
    params.push(limit, offset)
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_production_tasks WHERE ${conditions.join(' AND ')}
       ORDER BY (priority = 'URGENT') DESC, (status = 'COMPLETED') ASC, created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return rows.map((row) => this._format(row))
  }

  async assign(id, assignedTo) {
    const { rows } = await query(
      `UPDATE vendor_production_tasks SET assigned_to = $2, updated_at = NOW() WHERE id = $1 AND status IN ('OPEN', 'IN_PROGRESS') RETURNING ${COLUMNS}`,
      [id, assignedTo]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async start(id, actorUserId) {
    const { rows } = await query(
      `UPDATE vendor_production_tasks SET status = 'IN_PROGRESS', started_at = NOW(), started_by = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'OPEN' RETURNING ${COLUMNS}`,
      [id, actorUserId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, garmentUnitId: row.garment_unit_id, orderId: row.order_id,
      station: row.station, kind: row.kind, status: row.status, priority: row.priority, assignedTo: row.assigned_to,
      reason: row.reason, completionNote: row.completion_note, outputState: row.output_state,
      startedAt: row.started_at, startedBy: row.started_by, completedAt: row.completed_at, completedBy: row.completed_by,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
