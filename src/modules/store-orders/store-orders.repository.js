import { query } from '../../config/database.js'

const COLUMNS = `
  id, vendor_id, customer_user_id, pos_order_id, order_number, items,
  subtotal_paise, discount_paise, tax_paise, total_paise, payment_method,
  wallet_amount_paise, wallet_redemption_request_id, cash_shift_id, placed_at, created_at
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
         subtotal_paise, discount_paise, tax_paise, total_paise, payment_method,
         wallet_amount_paise, wallet_redemption_request_id, cash_shift_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (vendor_id, pos_order_id) DO UPDATE SET
         order_number = EXCLUDED.order_number,
         items = EXCLUDED.items,
         subtotal_paise = EXCLUDED.subtotal_paise,
         discount_paise = EXCLUDED.discount_paise,
         tax_paise = EXCLUDED.tax_paise,
         total_paise = EXCLUDED.total_paise,
         payment_method = EXCLUDED.payment_method,
         wallet_amount_paise = EXCLUDED.wallet_amount_paise,
         wallet_redemption_request_id = EXCLUDED.wallet_redemption_request_id,
         cash_shift_id = EXCLUDED.cash_shift_id
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
        data.walletAmountPaise ?? 0,
        data.walletRedemptionRequestId ?? null,
        data.cashShiftId ?? null,
      ]
    )
    return this._format(rows[0])
  }

  /**
   * One walk-in order for its own customer — with the vendor's contact
   * details and every payment taken against it, for the order-details screen.
   * Returns null for an id that doesn't exist or belongs to someone else, so
   * the route can't be used to probe other customers' orders.
   */
  async findOneForCustomer(id, customerUserId) {
    const { rows } = await query(
      `SELECT so.*, v.name AS vendor_name, v.phone AS vendor_phone,
              concat_ws(', ', v.address_line1, v.address_line2, v.city, v.pincode) AS vendor_address
       FROM store_orders so
       JOIN vendors v ON v.id = so.vendor_id
       WHERE so.id = $1 AND so.customer_user_id = $2`,
      [id, customerUserId]
    )
    if (!rows[0]) return null
    const { rows: payments } = await query(
      `SELECT mode, amount_paise, created_at
       FROM store_order_payments
       WHERE store_order_id = $1
       ORDER BY created_at ASC`,
      [id]
    )
    return {
      ...this._format(rows[0]),
      vendorPhone: rows[0].vendor_phone ?? null,
      vendorAddress: rows[0].vendor_address || null,
      payments: payments.map((p) => ({ mode: p.mode, amountPaise: p.amount_paise, createdAt: p.created_at })),
    }
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
      // Lifecycle (migration 130). Rows pushed by the old desktop sync are
      // already complete, which is exactly what the column defaults say.
      status: row.status ?? 'DELIVERED',
      chargesPaise: row.charges_paise ?? 0,
      amountPaidPaise: row.amount_paid_paise ?? row.total_paise,
      expectedDeliveryDate: row.expected_delivery_date ?? null,
      notes: row.notes ?? null,
      fulfillmentMode: row.fulfillment_mode ?? null,
      walletAmountPaise: row.wallet_amount_paise,
      walletRedemptionRequestId: row.wallet_redemption_request_id,
      cashShiftId: row.cash_shift_id,
      placedAt: row.placed_at,
      createdAt: row.created_at,
    }
  }
}
