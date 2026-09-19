import { query } from '../../../config/database.js'

const COLUMNS = `
  id, question, answer, sort_order, is_active, created_by, created_at, updated_at
`

/**
 * Help FAQs repository — the admin-managed list behind the customer app's
 * "Help & FAQs" screen (migration 133).
 */
export class HelpFaqsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM help_faqs ORDER BY sort_order ASC, created_at ASC`
    )
    return rows.map(this._format)
  }

  async findAllActive() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM help_faqs WHERE is_active = true ORDER BY sort_order ASC, created_at ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM help_faqs WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO help_faqs (question, answer, sort_order, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [data.question, data.answer, data.sortOrder ?? 0, data.isActive ?? true, data.createdBy ?? null]
    )
    return this._format(rows[0])
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      question: 'question',
      answer: 'answer',
      sortOrder: 'sort_order',
      isActive: 'is_active',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push('updated_at = NOW()')
    params.push(id)
    const { rows } = await query(
      `UPDATE help_faqs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query('DELETE FROM help_faqs WHERE id = $1', [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      question: row.question,
      answer: row.answer,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
