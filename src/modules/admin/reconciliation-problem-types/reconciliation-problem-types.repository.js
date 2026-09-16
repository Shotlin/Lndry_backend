import { query } from '../../../config/database.js'

const COLUMNS = `
  id, label, description, is_active, sort_order, created_by, created_at, updated_at
`

/**
 * Reconciliation Problem Types repository — the admin-curated, universal
 * library of reasons a vendor can attach to a flagged line item during
 * order reconciliation (re-evaluation), e.g. "Damaged Item". Every vendor
 * sees the same list; only an admin can add/edit/remove entries.
 */
export class ReconciliationProblemTypesRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM reconciliation_problem_types ORDER BY sort_order ASC, created_at ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM reconciliation_problem_types WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async findAllActive() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM reconciliation_problem_types WHERE is_active = true ORDER BY sort_order ASC, created_at ASC`
    )
    return rows.map(this._format)
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO reconciliation_problem_types (label, description, sort_order, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [data.label, data.description ?? null, data.sortOrder ?? 0, data.createdBy ?? null]
    )
    return this._format(rows[0])
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      label: 'label',
      description: 'description',
      isActive: 'is_active',
      sortOrder: 'sort_order',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push(`updated_at = NOW()`)
    params.push(id)
    const { rows } = await query(
      `UPDATE reconciliation_problem_types SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM reconciliation_problem_types WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      label: row.label,
      description: row.description,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
