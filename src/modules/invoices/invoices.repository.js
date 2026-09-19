import { query, getClient } from '../../config/database.js'

const COLUMNS = `
  id, invoice_number, order_type, order_id, order_number, customer_id, vendor_id, status,
  invoice_date, issued_at, currency, subtotal_paise, discount_paise, delivery_fee_paise,
  platform_fee_paise, tax_paise, total_paise, amount_paid_paise, balance_due_paise,
  payment_status, payment_method, template_id, pdf_ref, pdf_sha256, pdf_size_bytes,
  pdf_generated_at, created_at, updated_at`

/**
 * Invoices repository (migration 135).
 */
export class InvoicesRepository {
  async findByOrder(orderType, orderId) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM invoices WHERE order_type = $1 AND order_id = $2`,
      [orderType, orderId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async findById(invoiceId) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM invoices WHERE id = $1`, [invoiceId])
    return rows[0] ? this._format(rows[0]) : null
  }

  async findSnapshot(invoiceId) {
    const { rows } = await query(`SELECT snapshot FROM invoices WHERE id = $1`, [invoiceId])
    return rows[0]?.snapshot ?? null
  }

  async findPdf(invoiceId) {
    const { rows } = await query(
      `SELECT pdf, content_type FROM invoice_files WHERE invoice_id = $1`,
      [invoiceId]
    )
    return rows[0] ? { buffer: rows[0].pdf, contentType: rows[0].content_type } : null
  }

  /**
   * Issues the invoice for an order exactly once.
   *
   * Runs in one transaction under a per-order advisory lock, so two requests
   * for the same order at the same moment cannot both allocate a number: the
   * second waits, sees the first one's row and returns it (created: false).
   * `prepare(number)` is called inside the lock once the number is known and
   * must return { snapshot, pdf, templateId } — the PDF contains the number,
   * so it can only be rendered after the number exists.
   */
  async issueOnce({ orderType, orderId, customerId, vendorId, orderNumber, numberFor, prepare }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`invoice:${orderType}:${orderId}`])

      const existing = await client.query(
        `SELECT ${COLUMNS} FROM invoices WHERE order_type = $1 AND order_id = $2`,
        [orderType, orderId]
      )
      if (existing.rows[0]) {
        await client.query('COMMIT')
        return { invoice: this._format(existing.rows[0]), created: false }
      }

      const seq = await client.query(`SELECT nextval('invoice_number_seq') AS n`)
      const { snapshot, pdf, templateId, sha256 } = await prepare(numberFor(Number(seq.rows[0].n)))

      const t = snapshot.totals
      const p = snapshot.payment
      const { rows } = await client.query(
        `INSERT INTO invoices (
           invoice_number, order_type, order_id, order_number, customer_id, vendor_id,
           invoice_date, currency, subtotal_paise, discount_paise, delivery_fee_paise,
           platform_fee_paise, tax_paise, total_paise, amount_paid_paise, balance_due_paise,
           payment_status, payment_method, snapshot, template_id, pdf_ref, pdf_sha256,
           pdf_size_bytes, pdf_generated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
         RETURNING ${COLUMNS}`,
        [
          snapshot.invoice.number, orderType, orderId, orderNumber ?? null, customerId, vendorId ?? null,
          snapshot.invoice.invoiceDate, snapshot.invoice.currency,
          t.subtotalPaise, t.discountPaise, t.deliveryFeePaise, t.platformFeePaise + t.expressFeePaise,
          t.taxPaise, t.totalPaise, p.paidPaise, p.balanceDuePaise,
          p.status, p.method, JSON.stringify(snapshot), templateId, 'db:invoice_files', sha256, pdf.length,
        ]
      )
      await client.query(`INSERT INTO invoice_files (invoice_id, pdf) VALUES ($1, $2)`, [rows[0].id, pdf])
      await client.query('COMMIT')
      return { invoice: this._format(rows[0]), created: true }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Replaces the stored PDF (and optionally the snapshot) — same invoice number and id. */
  async replaceRendition(invoiceId, { pdf, sha256, templateId, snapshot }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      if (snapshot) {
        const t = snapshot.totals
        const p = snapshot.payment
        await client.query(
          `UPDATE invoices SET snapshot = $2, subtotal_paise = $3, discount_paise = $4, delivery_fee_paise = $5,
                  platform_fee_paise = $6, tax_paise = $7, total_paise = $8, amount_paid_paise = $9,
                  balance_due_paise = $10, payment_status = $11, payment_method = $12
            WHERE id = $1`,
          [
            invoiceId, JSON.stringify(snapshot), t.subtotalPaise, t.discountPaise, t.deliveryFeePaise,
            t.platformFeePaise + t.expressFeePaise, t.taxPaise, t.totalPaise, p.paidPaise,
            p.balanceDuePaise, p.status, p.method,
          ]
        )
      }
      await client.query(
        `UPDATE invoices SET template_id = $2, pdf_sha256 = $3, pdf_size_bytes = $4,
                pdf_generated_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [invoiceId, templateId, sha256, pdf.length]
      )
      await client.query(
        `INSERT INTO invoice_files (invoice_id, pdf) VALUES ($1, $2)
         ON CONFLICT (invoice_id) DO UPDATE SET pdf = EXCLUDED.pdf, updated_at = NOW()`,
        [invoiceId, pdf]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async listOrderRefs({ limit }) {
    const { rows } = await query(
      `SELECT order_type, order_id FROM invoices ORDER BY issued_at ASC LIMIT $1`,
      [limit]
    )
    return rows.map((r) => ({ orderType: r.order_type, orderId: r.order_id }))
  }

  _format(row) {
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      orderType: row.order_type,
      orderId: row.order_id,
      orderNumber: row.order_number,
      customerId: row.customer_id,
      vendorId: row.vendor_id,
      status: row.status,
      invoiceDate: row.invoice_date,
      issuedAt: row.issued_at,
      currency: row.currency,
      subtotalPaise: row.subtotal_paise,
      discountPaise: row.discount_paise,
      deliveryFeePaise: row.delivery_fee_paise,
      platformFeePaise: row.platform_fee_paise,
      taxPaise: row.tax_paise,
      totalPaise: row.total_paise,
      amountPaidPaise: row.amount_paid_paise,
      balanceDuePaise: row.balance_due_paise,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      templateId: row.template_id,
      pdfRef: row.pdf_ref,
      pdfSha256: row.pdf_sha256,
      pdfSizeBytes: row.pdf_size_bytes,
      pdfGeneratedAt: row.pdf_generated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
