import { query, getClient } from '../../config/database.js'

const DEF_COLUMNS = `id, vendor_id, name, description, price_paise, validity_days, active, created_at, updated_at`
const LINE_COLUMNS = `id, package_id, vendor_service_rate_id, allowance`
const CUSTOMER_PKG_COLUMNS = `
  id, vendor_id, package_id, customer_user_id, purchased_date, expires_on, contract_price_paise,
  price_paid_paise, payment_mode, payment_status, status, created_by, created_at, updated_at
`
const PAYMENT_COLUMNS = `id, customer_package_id, amount_paise, mode, reference, payment_date, reason, created_by, created_at`
const REDEMPTION_COLUMNS = `id, customer_package_id, vendor_service_rate_id, quantity, redeemed_date, order_id, reason, created_by, created_at`

/**
 * Vendor Service Packages repository — prepaid package definitions,
 * customer purchases, payments and redemptions, ported from
 * epic-laundry-desktop's packages.ts. See migration 121.
 */
export class VendorServicePackagesRepository {
  // ── Definitions ──────────────────────────────────────────────
  async listDefinitions(vendorId, includeInactive = false) {
    const clause = includeInactive ? '' : 'AND active = true'
    const { rows } = await query(`SELECT ${DEF_COLUMNS} FROM vendor_service_packages WHERE vendor_id = $1 ${clause} ORDER BY name ASC`, [vendorId])
    return rows.map((row) => this._formatDefinition(row))
  }

  async findDefinition(vendorId, id) {
    const { rows } = await query(`SELECT ${DEF_COLUMNS} FROM vendor_service_packages WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._formatDefinition(rows[0]) : null
  }

  async createDefinition(vendorId, input) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO vendor_service_packages (vendor_id, name, description, price_paise, validity_days, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${DEF_COLUMNS}`,
        [vendorId, input.name, input.description ?? null, input.pricePaise, input.validityDays, input.active !== false]
      )
      const definition = rows[0]
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO vendor_service_package_lines (package_id, vendor_service_rate_id, allowance) VALUES ($1, $2, $3)`,
          [definition.id, line.vendorServiceRateId, line.allowance]
        )
      }
      await client.query('COMMIT')
      return this.findDefinition(vendorId, definition.id)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async linesFor(packageId) {
    const { rows } = await query(
      `SELECT l.${LINE_COLUMNS.replace(/, /g, ', l.')}, r.rate_paise, vs.name AS service_name, gt.name AS garment_name
       FROM vendor_service_package_lines l
       JOIN vendor_service_rates r ON r.id = l.vendor_service_rate_id
       JOIN vendor_services vs ON vs.id = r.vendor_service_id
       JOIN garment_types gt ON gt.id = r.garment_type_id
       WHERE l.package_id = $1`,
      [packageId]
    )
    return rows.map((row) => ({
      id: row.id, vendorServiceRateId: row.vendor_service_rate_id, allowance: Number(row.allowance),
      ratePaise: row.rate_paise, serviceName: row.service_name, garmentName: row.garment_name,
    }))
  }

  _formatDefinition(row) {
    return {
      id: row.id, vendorId: row.vendor_id, name: row.name, description: row.description,
      pricePaise: row.price_paise, validityDays: row.validity_days, active: row.active,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  // ── Customer packages ────────────────────────────────────────
  async purchase(vendorId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_customer_packages (
         vendor_id, package_id, customer_user_id, purchased_date, expires_on, contract_price_paise,
         price_paid_paise, payment_mode, payment_status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${CUSTOMER_PKG_COLUMNS}`,
      [
        vendorId, input.packageId, input.customerUserId, input.purchasedDate, input.expiresOn,
        input.contractPricePaise, input.pricePaidPaise, input.paymentMode, input.paymentStatus, actorUserId,
      ]
    )
    return this._formatCustomerPackage(rows[0])
  }

  async findCustomerPackage(vendorId, id) {
    const { rows } = await query(`SELECT ${CUSTOMER_PKG_COLUMNS} FROM vendor_customer_packages WHERE vendor_id = $1 AND id = $2`, [vendorId, id])
    return rows[0] ? this._formatCustomerPackage(rows[0]) : null
  }

  async listForCustomer(vendorId, customerUserId) {
    const { rows } = await query(
      `SELECT ${CUSTOMER_PKG_COLUMNS} FROM vendor_customer_packages
       WHERE vendor_id = $1 AND customer_user_id = $2 ORDER BY purchased_date DESC, created_at DESC`,
      [vendorId, customerUserId]
    )
    return rows.map((row) => this._formatCustomerPackage(row))
  }

  async updateCustomerPackagePayment(id, { pricePaidPaise, paymentStatus, paymentMode, status }) {
    const { rows } = await query(
      `UPDATE vendor_customer_packages SET price_paid_paise = $2, payment_status = $3, payment_mode = COALESCE($4, payment_mode),
         status = COALESCE($5, status), updated_at = NOW()
       WHERE id = $1 RETURNING ${CUSTOMER_PKG_COLUMNS}`,
      [id, pricePaidPaise, paymentStatus, paymentMode ?? null, status ?? null]
    )
    return rows[0] ? this._formatCustomerPackage(rows[0]) : null
  }

  async markStatus(id, status) {
    const { rows } = await query(
      `UPDATE vendor_customer_packages SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING ${CUSTOMER_PKG_COLUMNS}`,
      [id, status]
    )
    return rows[0] ? this._formatCustomerPackage(rows[0]) : null
  }

  _formatCustomerPackage(row) {
    return {
      id: row.id, vendorId: row.vendor_id, packageId: row.package_id, customerUserId: row.customer_user_id,
      purchasedDate: row.purchased_date, expiresOn: row.expires_on, contractPricePaise: row.contract_price_paise,
      pricePaidPaise: row.price_paid_paise, paymentMode: row.payment_mode, paymentStatus: row.payment_status,
      status: row.status, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  // ── Payments ──────────────────────────────────────────────────
  async addPayment(customerPackageId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_customer_package_payments (customer_package_id, amount_paise, mode, reference, payment_date, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PAYMENT_COLUMNS}`,
      [customerPackageId, input.amountPaise, input.mode, input.reference ?? null, input.paymentDate, input.reason ?? null, actorUserId]
    )
    return this._formatPayment(rows[0])
  }

  async paymentsFor(customerPackageId) {
    const { rows } = await query(`SELECT ${PAYMENT_COLUMNS} FROM vendor_customer_package_payments WHERE customer_package_id = $1 ORDER BY created_at ASC`, [customerPackageId])
    return rows.map((row) => this._formatPayment(row))
  }

  _formatPayment(row) {
    return {
      id: row.id, customerPackageId: row.customer_package_id, amountPaise: row.amount_paise, mode: row.mode,
      reference: row.reference, paymentDate: row.payment_date, reason: row.reason, createdBy: row.created_by, createdAt: row.created_at,
    }
  }

  // ── Redemptions ───────────────────────────────────────────────
  async redeem(customerPackageId, actorUserId, input) {
    const { rows } = await query(
      `INSERT INTO vendor_package_redemptions (customer_package_id, vendor_service_rate_id, quantity, redeemed_date, order_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${REDEMPTION_COLUMNS}`,
      [customerPackageId, input.vendorServiceRateId, input.quantity, input.redeemedDate, input.orderId ?? null, input.reason ?? null, actorUserId]
    )
    return this._formatRedemption(rows[0])
  }

  async redemptionsFor(customerPackageId) {
    const { rows } = await query(`SELECT ${REDEMPTION_COLUMNS} FROM vendor_package_redemptions WHERE customer_package_id = $1 ORDER BY created_at ASC`, [customerPackageId])
    return rows.map((row) => this._formatRedemption(row))
  }

  _formatRedemption(row) {
    return {
      id: row.id, customerPackageId: row.customer_package_id, vendorServiceRateId: row.vendor_service_rate_id,
      quantity: Number(row.quantity), redeemedDate: row.redeemed_date, orderId: row.order_id, reason: row.reason,
      createdBy: row.created_by, createdAt: row.created_at,
    }
  }

  async findServiceRate(vendorId, id) {
    const { rows } = await query(
      `SELECT r.id, r.vendor_service_id, r.garment_type_id, r.rate_paise, r.is_active
       FROM vendor_service_rates r JOIN vendor_services vs ON vs.id = r.vendor_service_id
       WHERE vs.vendor_id = $1 AND r.id = $2`,
      [vendorId, id]
    )
    return rows[0] || null
  }
}
