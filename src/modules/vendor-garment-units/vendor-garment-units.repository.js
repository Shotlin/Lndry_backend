import { query, getClient } from '../../config/database.js'

const UNIT_COLUMNS = `id, vendor_id, order_id, order_line_id, customer_user_id, garment_type_id, sequence, active_tag_code, state, location, condition, created_by, created_at, updated_at`

const GARMENT_TRANSITIONS = {
  INTAKE: ['SORTED', 'PROCESSING', 'CANCELLED', 'MISSING', 'DAMAGED'],
  SORTED: ['PROCESSING', 'CANCELLED', 'MISSING', 'DAMAGED'],
  PROCESSING: ['QC', 'REWASH', 'CANCELLED', 'MISSING', 'DAMAGED'],
  QC: ['ASSEMBLY', 'REWASH', 'CANCELLED', 'MISSING', 'DAMAGED'],
  REWASH: ['PROCESSING', 'QC', 'CANCELLED', 'MISSING', 'DAMAGED'],
  ASSEMBLY: ['RACKED', 'CANCELLED', 'MISSING', 'DAMAGED'],
  RACKED: ['DISPATCHED', 'CANCELLED', 'MISSING', 'DAMAGED'],
  DISPATCHED: ['DELIVERED', 'MISSING', 'DAMAGED'],
  DELIVERED: [], MISSING: [], DAMAGED: [], CANCELLED: [],
}

const randomTagCode = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

/**
 * Vendor Garment Units repository — one row per physical garment, ported
 * from epic-laundry-desktop's domain.ts garment-unit functions. See
 * migration 122.
 */
export class VendorGarmentUnitsRepository {
  static TRANSITIONS = GARMENT_TRANSITIONS

  async findOrderLine(vendorId, orderLineId) {
    const { rows } = await query(
      `SELECT ol.id, ol.order_id, ol.garment_type_id, ol.confirmed_quantity, ol.estimated_quantity, o.user_id AS customer_user_id, gt.unit
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
       JOIN garment_types gt ON gt.id = ol.garment_type_id
       WHERE ol.id = $1 AND o.vendor_id = $2`,
      [orderLineId, vendorId]
    )
    return rows[0] || null
  }

  async existingSequenceCount(orderLineId) {
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM vendor_garment_units WHERE order_line_id = $1', [orderLineId])
    return rows[0].count
  }

  async createBatch(vendorId, actorUserId, orderId, orderLineId, customerUserId, garmentTypeId, count, startSequence) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const created = []
      for (let i = 0; i < count; i += 1) {
        const sequence = startSequence + i
        const tagCode = randomTagCode('ELT')
        const { rows } = await client.query(
          `INSERT INTO vendor_garment_units (vendor_id, order_id, order_line_id, customer_user_id, garment_type_id, sequence, active_tag_code, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${UNIT_COLUMNS}`,
          [vendorId, orderId, orderLineId, customerUserId, garmentTypeId, sequence, tagCode, actorUserId]
        )
        const unit = rows[0]
        await client.query(
          `INSERT INTO vendor_garment_tag_history (unit_id, tag_code, issued_by) VALUES ($1, $2, $3)`,
          [unit.id, tagCode, actorUserId]
        )
        await client.query(
          `INSERT INTO vendor_garment_unit_events (unit_id, event_type, to_state, location, actor_id, note)
           VALUES ($1, 'CREATED', 'INTAKE', 'Intake', $2, 'Created at order intake')`,
          [unit.id, actorUserId]
        )
        created.push(this._format(unit))
      }
      await client.query('COMMIT')
      return created
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async findByTag(vendorId, tagCode) {
    const { rows } = await query(`SELECT ${UNIT_COLUMNS} FROM vendor_garment_units WHERE vendor_id = $1 AND active_tag_code = $2`, [vendorId, tagCode])
    return rows[0] ? this._format(rows[0]) : null
  }

  async findRetiredTag(vendorId, tagCode) {
    const { rows } = await query(
      `SELECT h.*, u.vendor_id FROM vendor_garment_tag_history h
       JOIN vendor_garment_units u ON u.id = h.unit_id
       WHERE u.vendor_id = $1 AND h.tag_code = $2`,
      [vendorId, tagCode]
    )
    return rows[0] || null
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${UNIT_COLUMNS} FROM vendor_garment_units WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async listForOrder(vendorId, orderId) {
    const { rows } = await query(`SELECT ${UNIT_COLUMNS} FROM vendor_garment_units WHERE vendor_id = $1 AND order_id = $2 ORDER BY sequence ASC`, [vendorId, orderId])
    return rows.map((row) => this._format(row))
  }

  async isRackLocationTaken(vendorId, location, excludeUnitId) {
    const { rows } = await query(
      `SELECT id FROM vendor_garment_units WHERE vendor_id = $1 AND state = 'RACKED' AND lower(location) = lower($2) AND id != $3`,
      [vendorId, location, excludeUnitId || '00000000-0000-0000-0000-000000000000']
    )
    return rows.length > 0
  }

  async transition(id, { state, location, condition }) {
    const { rows } = await query(
      `UPDATE vendor_garment_units SET state = $2, location = $3, condition = $4, updated_at = NOW() WHERE id = $1 RETURNING ${UNIT_COLUMNS}`,
      [id, state, location, condition]
    )
    return this._format(rows[0])
  }

  async touch(id, { location, condition }) {
    const { rows } = await query(
      `UPDATE vendor_garment_units SET location = $2, condition = $3, updated_at = NOW() WHERE id = $1 RETURNING ${UNIT_COLUMNS}`,
      [id, location, condition]
    )
    return this._format(rows[0])
  }

  async appendEvent(unitId, { eventType, fromState, toState, location, note, actorId }) {
    await query(
      `INSERT INTO vendor_garment_unit_events (unit_id, event_type, from_state, to_state, location, note, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [unitId, eventType, fromState ?? null, toState ?? null, location ?? null, note ?? null, actorId]
    )
  }

  async eventsFor(unitId) {
    const { rows } = await query(
      `SELECT id, event_type, from_state, to_state, location, note, actor_id, created_at FROM vendor_garment_unit_events WHERE unit_id = $1 ORDER BY created_at ASC`,
      [unitId]
    )
    return rows.map((row) => ({
      id: row.id, eventType: row.event_type, fromState: row.from_state, toState: row.to_state,
      location: row.location, note: row.note, actorId: row.actor_id, createdAt: row.created_at,
    }))
  }

  async tagHistoryFor(unitId) {
    const { rows } = await query(
      `SELECT id, tag_code, status, issued_at, issued_by, retired_at, retired_by, retirement_reason, replacement_tag_id, version
       FROM vendor_garment_tag_history WHERE unit_id = $1 ORDER BY version ASC`,
      [unitId]
    )
    return rows.map((row) => ({
      id: row.id, tagCode: row.tag_code, status: row.status, issuedAt: row.issued_at, issuedBy: row.issued_by,
      retiredAt: row.retired_at, retiredBy: row.retired_by, retirementReason: row.retirement_reason,
      replacementTagId: row.replacement_tag_id, version: row.version,
    }))
  }

  async createTagHistory(unitId, tagCode, actorUserId) {
    const { rows } = await query(
      `INSERT INTO vendor_garment_tag_history (unit_id, tag_code, issued_by) VALUES ($1, $2, $3) RETURNING id, tag_code, version`,
      [unitId, tagCode, actorUserId]
    )
    return rows[0]
  }

  async retireTagHistory(id, { status, retiredBy, retirementReason, replacementTagId }) {
    await query(
      `UPDATE vendor_garment_tag_history SET status = $2, retired_at = NOW(), retired_by = $3, retirement_reason = $4, replacement_tag_id = $5, version = version + 1
       WHERE id = $1`,
      [id, status, retiredBy, retirementReason, replacementTagId]
    )
  }

  async setActiveTag(unitId, tagCode) {
    const { rows } = await query(`UPDATE vendor_garment_units SET active_tag_code = $2, updated_at = NOW() WHERE id = $1 RETURNING ${UNIT_COLUMNS}`, [unitId, tagCode])
    return this._format(rows[0])
  }

  generateTagCode() {
    return randomTagCode('ELT')
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, orderId: row.order_id, orderLineId: row.order_line_id,
      customerUserId: row.customer_user_id, garmentTypeId: row.garment_type_id, sequence: row.sequence,
      activeTagCode: row.active_tag_code, state: row.state, location: row.location, condition: row.condition,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}
