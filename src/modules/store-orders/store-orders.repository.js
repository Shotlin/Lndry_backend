import { query } from '../../config/database.js'

const COLUMNS = `
  id, vendor_id, customer_user_id, pos_order_id, order_number, items,
  subtotal_paise, discount_paise, tax_paise, total_paise, payment_method,
  placed_at, created_at
`

/**
 * Store Orders repository — walk-in/counter sales pushed here by a vendor's
 * own POS desktop app (epic-laundry-desktop) when a walk-in customer's phone
 * matches a real LNDRY account. See migration 111_store_orders.sql for why
 * this is a separate table from `orders`.
 */
export class StoreOrdersRepository {
  async findByPhone(phone) {
    const { rows } = await query('SELECT id, name, phone FROM users WHERE phone = $1', [phone])
    return rows[0] || null
  }

  /** Upsert on (vendor_id, pos_order_id) so a retried push from the desktop is idempotent. */
  async upsert(data) {
    const { rows } = await query(
      `INSERT INTO store_orders (
         vendor_id, customer_user_id, pos_order_id, order_number, items,
         subtotal_paise, discount_paise, tax_paise, total_paise, payment_method
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (vendor_id, pos_order_id) DO UPDATE SET
         order_number = EXCLUDED.order_number,
         items = EXCLUDED.items,
         subtotal_paise = EXCLUDED.subtotal_paise,
         discount_paise = EXCLUDED.discount_paise,
         tax_paise = EXCLUDED.tax_paise,
         total_paise = EXCLUDED.total_paise,
         payment_method = EXCLUDED.payment_method
       RETURNING ${COLUMNS}`,
      [
        data.vendorId,
        data.customerUserId,
        data.posOrderId,
        data.orderNumber ?? null,
        JSON.stringify(data.items ?? []),
        data.subtotalPaise ?? 0,
        data.discountPaise ?? 0,
        data.taxPaise ?? 0,
        data.totalPaise,
        data.paymentMethod ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async findByCustomer(customerUserId) {
    const { rows } = await query(
      `SELECT so.*, v.name AS vendor_name
       FROM store_orders so
       JOIN vendors v ON v.id = so.vendor_id
       WHERE so.customer_user_id = $1
       ORDER BY so.placed_at DESC`,
      [customerUserId]
    )
    return rows.map((row) => this._format(row))
  }

  _format(row) {
    return {
      id: row.id,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name ?? undefined,
      customerUserId: row.customer_user_id,
      posOrderId: row.pos_order_id,
      orderNumber: row.order_number,
      items: row.items,
      subtotalPaise: row.subtotal_paise,
      discountPaise: row.discount_paise,
      taxPaise: row.tax_paise,
      totalPaise: row.total_paise,
      paymentMethod: row.payment_method,
      placedAt: row.placed_at,
      createdAt: row.created_at,
    }
  }
}
