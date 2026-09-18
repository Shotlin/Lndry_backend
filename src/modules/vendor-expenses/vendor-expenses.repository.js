import { query } from '../../config/database.js'

const COLUMNS = `
  id, vendor_id, expense_name, expense_date, amount_paise, category, payment_receiver, invoice_number,
  is_tax_paid, payment_mode, cash_shift_id, notes, attachment_url, status, cancellation_reason,
  edit_reason, created_by, created_at, updated_at
`

/**
 * Vendor Expenses repository — ported from epic-laundry-desktop's
 * domain.ts#createLaundryExpense (minus GL journal posting — see migration 116).
 */
export class VendorExpensesRepository {
  async create(vendorId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_expenses (
         vendor_id, expense_name, expense_date, amount_paise, category, payment_receiver, invoice_number,
         is_tax_paid, payment_mode, cash_shift_id, notes, attachment_url, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${COLUMNS}`,
      [
        vendorId, input.expenseName, input.expenseDate, input.amountPaise, input.category ?? 'UNCLASSIFIED',
        input.paymentReceiver ?? null, input.invoiceNumber ?? null, input.isTaxPaid ?? false,
        input.paymentMode ?? 'CASH', input.cashShiftId ?? null, input.notes ?? null, input.attachmentUrl ?? null,
        actorUserId,
      ]
    )
    return this._format(rows[0])
  }

  async findById(vendorId, id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM vendor_expenses WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._format(rows[0]) : null
  }

  async update(id, input) {
    const { rows } = await query(
      `UPDATE vendor_expenses SET
         expense_name = $2, expense_date = $3, amount_paise = $4, category = $5, payment_receiver = $6,
         invoice_number = $7, is_tax_paid = $8, payment_mode = $9, cash_shift_id = $10, notes = $11,
         attachment_url = $12, edit_reason = $13, updated_at = NOW()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [
        id, input.expenseName, input.expenseDate, input.amountPaise, input.category, input.paymentReceiver ?? null,
        input.invoiceNumber ?? null, input.isTaxPaid ?? false, input.paymentMode, input.cashShiftId ?? null,
        input.notes ?? null, input.attachmentUrl ?? null, input.editReason,
      ]
    )
    return this._format(rows[0])
  }

  async cancel(id, reason) {
    const { rows } = await query(
      `UPDATE vendor_expenses SET status = 'CANCELLED', cancellation_reason = $2, updated_at = NOW()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, reason]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async list(vendorId, { search, from, to, page = 1, limit = 20 } = {}) {
    const conditions = ['vendor_id = $1']
    const params = [vendorId]
    if (from) { params.push(from); conditions.push(`expense_date >= $${params.length}`) }
    if (to) { params.push(to); conditions.push(`expense_date <= $${params.length}`) }
    if (search) { params.push(`%${search}%`); conditions.push(`(expense_name ILIKE $${params.length} OR payment_receiver ILIKE $${params.length} OR invoice_number ILIKE $${params.length})`) }
    const offset = (page - 1) * limit
    params.push(limit, offset)
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_expenses WHERE ${conditions.join(' AND ')}
       ORDER BY expense_date DESC, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM vendor_expenses WHERE ${conditions.join(' AND ')}`,
      params.slice(0, params.length - 2)
    )
    return { expenses: rows.map((row) => this._format(row)), total: countRows[0].total }
  }

  _format(row) {
    return {
      id: row.id,
      vendorId: row.vendor_id,
      expenseName: row.expense_name,
      expenseDate: row.expense_date,
      amountPaise: row.amount_paise,
      category: row.category,
      paymentReceiver: row.payment_receiver,
      invoiceNumber: row.invoice_number,
      isTaxPaid: row.is_tax_paid,
      paymentMode: row.payment_mode,
      cashShiftId: row.cash_shift_id,
      notes: row.notes,
      attachmentUrl: row.attachment_url,
      status: row.status,
      cancellationReason: row.cancellation_reason,
      editReason: row.edit_reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
