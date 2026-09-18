import { query } from '../../config/database.js'

const COLUMNS = `
  id, vendor_id, customer_user_id, customer_name, customer_phone, entry_type,
  debit_paise, credit_paise, reference_type, reference_id, reason, entry_date, created_by, created_at
`

/**
 * Vendor Customer Ledger repository — per-vendor, per-customer running
 * account book, ported from epic-laundry-desktop's
 * customers.ts#appendCustomerLedger. See migration 115 for why
 * customer_user_id is nullable.
 */
export class VendorCustomerLedgerRepository {
  async findByPhone(vendorId, phone) {
    const { rows } = await query('SELECT id, name, phone FROM users WHERE phone = $1', [phone])
    return rows[0] || null
  }

  async append(vendorId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_customer_ledger (
         vendor_id, customer_user_id, customer_name, customer_phone, entry_type,
         debit_paise, credit_paise, reference_type, reference_id, reason, entry_date, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, CURRENT_DATE), $12)
       RETURNING ${COLUMNS}`,
      [
        vendorId,
        input.customerUserId ?? null,
        input.customerName ?? null,
        input.customerPhone ?? null,
        input.entryType,
        input.debitPaise ?? 0,
        input.creditPaise ?? 0,
        input.referenceType ?? null,
        input.referenceId ?? null,
        input.reason ?? null,
        input.entryDate ?? null,
        actorUserId,
      ]
    )
    return this._format(rows[0])
  }

  async listForCustomer(vendorId, { customerUserId, phone }) {
    const clause = customerUserId ? 'customer_user_id = $2' : 'customer_phone = $2'
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM vendor_customer_ledger WHERE vendor_id = $1 AND ${clause} ORDER BY entry_date DESC, created_at DESC`,
      [vendorId, customerUserId || phone]
    )
    return rows.map((row) => this._format(row))
  }

  _format(row) {
    return {
      id: row.id,
      vendorId: row.vendor_id,
      customerUserId: row.customer_user_id,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      entryType: row.entry_type,
      debitPaise: row.debit_paise,
      creditPaise: row.credit_paise,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      reason: row.reason,
      entryDate: row.entry_date,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }
  }
}
