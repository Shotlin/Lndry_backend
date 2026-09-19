import { query, getClient } from '../../config/database.js'

const CONTAINER_COLUMNS = `id, vendor_id, order_id, customer_user_id, tag_code, sequence, total_count, weight_kg, state, location, condition, created_by, created_at, updated_at, delivered_at`

const CONTAINER_TRANSITIONS = {
  INTAKE: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['READY', 'CANCELLED'],
  READY: ['DISPATCHED', 'DELIVERED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED: [], MISSING: [], DAMAGED: [], CANCELLED: [],
}

const randomTagCode = () => `ELB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

/**
 * Vendor Laundry Containers repository — bag/bin tracking for bulk
 * (weight-based) order lines, ported from epic-laundry-desktop's
 * domain.ts container functions. See migration 123.
 */
export class VendorLaundryContainersRepository {
  static TRANSITIONS = CONTAINER_TRANSITIONS

  async findOrder(vendorId, orderId) {
    const { rows } = await query(
      `SELECT id, user_id AS customer_user_id FROM orders WHERE id = $1 AND vendor_id = $2
       UNION ALL
       SELECT id, customer_user_id FROM store_orders WHERE id = $1 AND vendor_id = $2`,
      [orderId, vendorId]
    )
    return rows[0] || null
  }

  async existingCount(orderId) {
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM vendor_laundry_containers WHERE order_id = $1', [orderId])
    return rows[0].count
  }

  async createBatch(vendorId, actorUserId, orderId, customerUserId, count, weightKg) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const created = []
      for (let sequence = 1; sequence <= count; sequence += 1) {
        const tagCode = randomTagCode()
        const { rows } = await client.query(
          `INSERT INTO vendor_laundry_containers (vendor_id, order_id, customer_user_id, tag_code, sequence, total_count, weight_kg, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${CONTAINER_COLUMNS}`,
          [vendorId, orderId, customerUserId, tagCode, sequence, count, weightKg ?? null, actorUserId]
        )
        const container = rows[0]
        await client.query(
          `INSERT INTO vendor_laundry_container_events (container_id, event_type, to_state, location, actor_id, note)
           VALUES ($1, 'CREATED', 'INTAKE', 'Intake', $2, 'Created from explicit bag/container count at order intake')`,
          [container.id, actorUserId]
        )
        created.push(this._format(container))
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
    const { rows } = await query(`SELECT ${CONTAINER_COLUMNS} FROM vendor_laundry_containers WHERE vendor_id = $1 AND tag_code = $2`, [vendorId, tagCode])
    return rows[0] ? this._format(rows[0]) : null
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${CONTAINER_COLUMNS} FROM vendor_laundry_containers WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async listForOrder(vendorId, orderId) {
    const { rows } = await query(`SELECT ${CONTAINER_COLUMNS} FROM vendor_laundry_containers WHERE vendor_id = $1 AND order_id = $2 ORDER BY sequence ASC`, [vendorId, orderId])
    return rows.map((row) => this._format(row))
  }

  async transition(id, { state, location, condition, deliveredAt }) {
    const { rows } = await query(
      `UPDATE vendor_laundry_containers SET state = $2, location = $3, condition = $4, delivered_at = COALESCE($5, delivered_at), updated_at = NOW()
       WHERE id = $1 RETURNING ${CONTAINER_COLUMNS}`,
      [id, state, location, condition, deliveredAt ?? null]
    )
    return this._format(rows[0])
  }

  async touch(id, { location, condition }) {
    const { rows } = await query(
      `UPDATE vendor_laundry_containers SET location = $2, condition = $3, updated_at = NOW() WHERE id = $1 RETURNING ${CONTAINER_COLUMNS}`,
      [id, location, condition]
    )
    return this._format(rows[0])
  }

  async appendEvent(containerId, { eventType, fromState, toState, location, note, actorId }) {
    await query(
      `INSERT INTO vendor_laundry_container_events (container_id, event_type, from_state, to_state, location, note, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [containerId, eventType, fromState ?? null, toState ?? null, location ?? null, note ?? null, actorId]
    )
  }

  async eventsFor(containerId) {
    const { rows } = await query(
      `SELECT id, event_type, from_state, to_state, location, note, actor_id, created_at FROM vendor_laundry_container_events WHERE container_id = $1 ORDER BY created_at ASC`,
      [containerId]
    )
    return rows.map((row) => ({
      id: row.id, eventType: row.event_type, fromState: row.from_state, toState: row.to_state,
      location: row.location, note: row.note, actorId: row.actor_id, createdAt: row.created_at,
    }))
  }

  _format(row) {
    return {
      id: row.id, vendorId: row.vendor_id, orderId: row.order_id, customerUserId: row.customer_user_id,
      tagCode: row.tag_code, sequence: row.sequence, totalCount: row.total_count, weightKg: row.weight_kg,
      state: row.state, location: row.location, condition: row.condition, createdBy: row.created_by,
      createdAt: row.created_at, updatedAt: row.updated_at, deliveredAt: row.delivered_at,
    }
  }
}
