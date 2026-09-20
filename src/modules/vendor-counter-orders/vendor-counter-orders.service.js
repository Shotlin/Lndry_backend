import { randomUUID } from 'node:crypto'
import { query, getClient } from '../../config/database.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorAdjustmentRulesRepository } from '../vendor-adjustment-rules/vendor-adjustment-rules.repository.js'
import { amountForRule } from '../vendor-adjustment-rules/vendor-adjustment-rules.service.js'
import { VendorCustomerLedgerService } from '../vendor-customer-ledger/vendor-customer-ledger.service.js'
import { VendorCashShiftsRepository } from '../vendor-cash-shifts/vendor-cash-shifts.repository.js'
import { VendorProductionTasksService } from '../vendor-production-tasks/vendor-production-tasks.service.js'
import { VendorPosCatalogueService } from '../vendor-pos-catalogue/vendor-pos-catalogue.service.js'
import { scheduleInvoiceForDeliveredOrder } from '../invoices/invoice-jobs.js'
import { getVendorCapabilities, WALLET_RESTRICTED_MESSAGE, TIER_RESTRICTED } from '../vendors/vendor-tier.js'

const PAYMENT_MODES = ['CASH', 'UPI', 'CARD', 'BANK', 'WALLET']
const PIECE_UNITS = new Set(['piece', 'pc', 'pcs', 'pair'])
const STATES = ['BOOKED', 'PICKED_UP', 'IN_PROCESS', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']
const NEXT_STATES = {
  BOOKED: ['PICKED_UP', 'IN_PROCESS', 'CANCELLED'],
  PICKED_UP: ['IN_PROCESS', 'CANCELLED'],
  IN_PROCESS: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'READY'],
  DELIVERED: [],
  CANCELLED: [],
}
// A garment must be at assembly (or beyond) before the order can be called ready.
const NOT_READY_UNIT_STATES = ['INTAKE', 'SORTED', 'PROCESSING', 'QC', 'REWASH', 'MISSING']

// pg returns DATE columns as Date objects at local midnight — format them without shifting the day.
export const dateOnly = (value) => {
  if (!value) return null
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  return String(value).slice(0, 10)
}
const digits = (value) => String(value ?? '').replace(/\D/g, '')
const tag = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
const referralCode = () => Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('')
const fail = (message, code = 'VALIDATION_ERROR', status = 400) => ({ success: false, message, code, status })

export function paymentStatus(totalPaise, paidPaise) {
  if (paidPaise <= 0) return 'UNPAID'
  return paidPaise >= totalPaise ? 'PAID' : 'PART_PAID'
}

const ORDER_SELECT = `
  so.id, so.vendor_id, so.customer_user_id, so.pos_order_id, so.order_number, so.items,
  so.subtotal_paise, so.discount_paise, so.charges_paise, so.tax_paise, so.tax_rate_bps, so.total_paise,
  so.payment_method, so.amount_paid_paise, so.payment_reference, so.wallet_amount_paise, so.wallet_redemption_request_id,
  so.status, so.version, so.source, so.order_date, so.expected_delivery_date, so.fulfillment_mode,
  so.delivery_address, so.service_zone, so.notes, so.photo_path, so.cancel_reason, so.cash_shift_id,
  so.pickup_rider_employee_id, so.delivery_rider_employee_id, so.placed_at, so.updated_at,
  u.name AS customer_name, u.phone AS customer_phone,
  pr.name AS pickup_rider_name, pru.phone AS pickup_rider_phone,
  dr.name AS delivery_rider_name, dru.phone AS delivery_rider_phone`

const ORDER_FROM = `
  FROM store_orders so
  JOIN users u ON u.id = so.customer_user_id
  LEFT JOIN vendor_employees pe ON pe.id = so.pickup_rider_employee_id
  LEFT JOIN users pr ON pr.id = pe.user_id
  LEFT JOIN users pru ON pru.id = pe.user_id
  LEFT JOIN vendor_employees de ON de.id = so.delivery_rider_employee_id
  LEFT JOIN users dr ON dr.id = de.user_id
  LEFT JOIN users dru ON dru.id = de.user_id`

function presentOrder(row) {
  const paid = row.amount_paid_paise ?? 0
  return {
    id: row.id,
    orderNumber: row.order_number,
    customer: { id: row.customer_user_id, name: row.customer_name || '', phone: row.customer_phone || '' },
    items: row.items || [],
    subtotalPaise: row.subtotal_paise,
    chargesPaise: row.charges_paise,
    discountsPaise: row.discount_paise,
    taxRateBps: row.tax_rate_bps,
    taxPaise: row.tax_paise,
    totalPaise: row.total_paise,
    paymentMode: row.payment_method,
    amountPaidPaise: paid,
    paymentStatus: paymentStatus(row.total_paise, paid),
    paymentReference: row.payment_reference,
    walletAmountPaise: row.wallet_amount_paise,
    status: row.status,
    version: row.version,
    source: row.source,
    orderDate: dateOnly(row.order_date) || dateOnly(row.placed_at),
    expectedDeliveryDate: dateOnly(row.expected_delivery_date),
    fulfillmentMode: row.fulfillment_mode,
    deliveryAddress: row.delivery_address,
    serviceZone: row.service_zone,
    notes: row.notes,
    photoPath: row.photo_path,
    cancelReason: row.cancel_reason,
    pickupRider: row.pickup_rider_employee_id ? { id: row.pickup_rider_employee_id, name: row.pickup_rider_name || 'Captain', phone: row.pickup_rider_phone || '' } : null,
    deliveryRider: row.delivery_rider_employee_id ? { id: row.delivery_rider_employee_id, name: row.delivery_rider_name || 'Captain', phone: row.delivery_rider_phone || '' } : null,
    placedAt: row.placed_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Counter orders: walk-in / drop-off work orders booked by the vendor at the
 * counter. They live in store_orders (see migrations 111 and 130) — not in the
 * pickup-delivery orders table — and carry the full counter lifecycle:
 * garment tags, payments, rider hand-off, ready/deliver.
 */
export class VendorCounterOrdersService {
  constructor(
    adjustmentRulesRepo = new VendorAdjustmentRulesRepository(),
    ledger = new VendorCustomerLedgerService(),
    cashShifts = new VendorCashShiftsRepository(),
    productionTasks = new VendorProductionTasksService(),
    posCatalogue = new VendorPosCatalogueService()
  ) {
    this.adjustmentRules = adjustmentRulesRepo
    this.ledger = ledger
    this.cashShifts = cashShifts
    this.productionTasks = productionTasks
    this.posCatalogue = posCatalogue
  }

  /** What this vendor's counter may do with the LNDRY ecosystem, from its CURRENT type. */
  async access(vendorId) {
    return getVendorCapabilities(vendorId)
  }

  // ── Customers ────────────────────────────────────────────────────────────

  /** People this vendor has dealt with, optionally narrowed by name/phone. */
  async listCustomers(vendorId, search = '') {
    const needle = String(search || '').trim().toLowerCase()
    const phoneDigits = digits(search)
    const { rows } = await query(
      `WITH known AS (
         SELECT customer_user_id AS user_id, MAX(placed_at) AS last_at, COUNT(*)::int AS orders, COALESCE(SUM(total_paise), 0)::bigint AS spent
         FROM store_orders WHERE vendor_id = $1 AND status <> 'CANCELLED' GROUP BY customer_user_id
         UNION ALL
         SELECT user_id, MAX(created_at), COUNT(*)::int, 0::bigint FROM orders WHERE vendor_id = $1 GROUP BY user_id
       ), merged AS (
         SELECT user_id, MAX(last_at) AS last_at, SUM(orders)::int AS orders, SUM(spent)::bigint AS spent FROM known GROUP BY user_id
       )
       SELECT u.id, u.name, u.phone, m.last_at, m.orders, m.spent
       FROM merged m JOIN users u ON u.id = m.user_id
       WHERE ($2 = '' OR lower(COALESCE(u.name, '')) LIKE '%' || $2 || '%' OR ($3 <> '' AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%'))
       ORDER BY m.last_at DESC NULLS LAST
       LIMIT 200`,
      [vendorId, needle, phoneDigits.length >= 2 ? phoneDigits : '']
    )
    return rows.map((r) => ({ id: r.id, name: r.name || '', phone: r.phone || '', lastOrderAt: r.last_at, orderCount: r.orders, spentPaise: Number(r.spent) }))
  }

  /**
   * Find the account for a phone or create it (name + phone only, no password —
   * this backend authenticates by OTP alone, so if the person later signs up
   * with the same phone they simply land on this row and their history is there).
   */
  async findOrCreateCustomer(vendorId, actor, { name, phone }) {
    const clean = digits(phone).slice(-10)
    if (clean.length !== 10) return fail('Enter a valid 10-digit phone number')
    const display = String(name || '').trim().slice(0, 100)
    const existing = await query('SELECT id, name, phone FROM users WHERE phone = $1 OR phone = $2 OR phone = $3 LIMIT 1', [clean, `+91${clean}`, `91${clean}`])
    if (existing.rows[0]) {
      const row = existing.rows[0]
      const caps = await getVendorCapabilities(vendorId)
      if (!caps.appSync) {
        // Standard vendor's POS: an existing LNDRY account is invisible to it. Until the vendor has
        // dealt with this person themselves it behaves exactly like a brand-new customer —
        // the vendor supplies the name, the account's own name is never shown or changed.
        if (!(await this._hasHistory(vendorId, row.id))) {
          if (!display) return fail('Customer name is required for a new customer')
          return { success: true, customer: { id: row.id, name: display, phone: clean }, created: true }
        }
        return { success: true, customer: { id: row.id, name: row.name || display, phone: row.phone }, created: false }
      }
      if (!row.name && display) await query('UPDATE users SET name = $2, updated_at = NOW() WHERE id = $1', [row.id, display])
      return { success: true, customer: { id: row.id, name: row.name || display, phone: row.phone }, created: false }
    }
    if (!display) return fail('Customer name is required for a new customer')
    const { rows } = await query(
      `INSERT INTO users (phone, name, role, referral_code) VALUES ($1, $2, 'CUSTOMER', $3) RETURNING id, name, phone`,
      [clean, display, referralCode()]
    )
    emitAudit('vendor_customer_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'user', target_id: rows[0].id,
      before: null, after: { phone: clean, vendorId }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, customer: rows[0], created: true }
  }

  /** Has this vendor already dealt with the person (a counter sale, an app order, or a ledger entry)? */
  async _hasHistory(vendorId, userId) {
    const { rows } = await query(
      `SELECT 1 FROM store_orders WHERE vendor_id = $1 AND customer_user_id = $2
       UNION ALL SELECT 1 FROM orders WHERE vendor_id = $1 AND user_id = $2
       UNION ALL SELECT 1 FROM vendor_customer_ledger WHERE vendor_id = $1 AND customer_user_id = $2
       LIMIT 1`,
      [vendorId, userId]
    )
    return rows.length > 0
  }

  async customerProfile(vendorId, customerId) {
    const { rows } = await query('SELECT id, name, phone, email FROM users WHERE id = $1', [customerId])
    if (!rows[0]) return null
    // A Standard vendor never receives an LNDRY account's e-mail address.
    if (!(await getVendorCapabilities(vendorId)).appSync) rows[0].email = null
    const orders = await this.listOrders(vendorId, { customerId, limit: 100 })
    const balance = await query(
      `SELECT COALESCE(SUM(debit_paise - credit_paise), 0)::bigint AS balance FROM vendor_customer_ledger WHERE vendor_id = $1 AND customer_user_id = $2`,
      [vendorId, customerId]
    ).catch(() => ({ rows: [{ balance: 0 }] }))
    return { customer: rows[0], orders, ledgerBalancePaise: Number(balance.rows[0]?.balance || 0) }
  }

  // ── Pricing ──────────────────────────────────────────────────────────────

  /**
   * Prices counter lines from the vendor's POS catalogue (pos_prices) — never from the marketplace
   * rates, so a POS price of ₹90 is used even when the app price is ₹80. Lines name a POS garment
   * and POS service; ids from before the POS catalogue existed (the LNDRY garment/service ids a
   * saved draft may still hold) are matched through the link kept on the imported rows.
   */
  async _priceItems(vendorId, items, customerUserId = null) {
    if (!Array.isArray(items) || !items.length) return fail('Select at least one garment.')
    const wanted = items.map((item) => ({ garment: item.garmentId ?? item.garmentTypeId, service: item.serviceId ?? item.vendorServiceId, qty: item.qty }))
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (wanted.some((line) => !uuid.test(String(line.garment)) || !uuid.test(String(line.service)))) return fail('Each garment line needs a garment and a service.')
    const seen = new Set()
    for (const line of wanted) {
      const key = `${line.garment}:${line.service}`
      if (seen.has(key)) return fail('Duplicate garment and service lines must be combined.')
      seen.add(key)
    }
    await this.posCatalogue.ensureFresh(vendorId, { maxAgeMs: 10_000 })
    const { rows } = await query(
      `SELECT p.rate_paise, p.customer_user_id, p.active AS price_active,
              g.id AS garment_id, g.name AS garment_name, g.unit, g.active AS garment_active, g.marketplace_garment_type_id,
              NULLIF(concat_ws(' / ', pc.name, c.name), '') AS category_name,
              s.id AS service_id, s.name AS service_name, s.active AS service_active, s.marketplace_service_id
       FROM pos_prices p
       JOIN pos_garments g ON g.id = p.garment_id AND g.vendor_id = p.vendor_id
       JOIN pos_services s ON s.id = p.service_id AND s.vendor_id = p.vendor_id
       LEFT JOIN pos_categories c ON c.id = g.category_id AND c.vendor_id = p.vendor_id
       LEFT JOIN pos_categories pc ON pc.id = c.parent_id AND pc.vendor_id = p.vendor_id
       WHERE p.vendor_id = $1 AND (p.customer_user_id IS NULL OR p.customer_user_id = $4)
         AND (g.id = ANY($2::uuid[]) OR g.marketplace_garment_type_id = ANY($2::uuid[]))
         AND (s.id = ANY($3::uuid[]) OR s.marketplace_service_id = ANY($3::uuid[]))`,
      [vendorId, wanted.map((l) => l.garment), wanted.map((l) => l.service), customerUserId]
    )
    const priced = []
    let subtotalPaise = 0
    for (const line of wanted) {
      const matches = rows.filter((r) => (r.garment_id === line.garment || r.marketplace_garment_type_id === line.garment) && (r.service_id === line.service || r.marketplace_service_id === line.service))
      // A price set for this customer wins over the general price.
      const rate = matches.find((r) => r.customer_user_id && r.price_active && r.garment_active && r.service_active) || matches.find((r) => !r.customer_user_id && r.price_active && r.garment_active && r.service_active)
      if (!rate) return fail('No active price exists for this garment and service.')
      const qty = Number(line.qty)
      if (!Number.isFinite(qty) || qty <= 0) return fail('Each garment line needs a positive quantity.')
      if (PIECE_UNITS.has(String(rate.unit).toLowerCase()) && !Number.isInteger(qty)) return fail(`${rate.garment_name} must be a whole number of pieces.`)
      const amountPaise = Math.round(rate.rate_paise * qty)
      subtotalPaise += amountPaise
      priced.push({
        garmentId: rate.garment_id, serviceId: rate.service_id,
        garmentTypeId: rate.marketplace_garment_type_id || null, vendorServiceId: rate.marketplace_service_id || null,
        name: rate.garment_name, serviceName: rate.service_name, categoryName: rate.category_name || null, unit: rate.unit, qty, ratePaise: rate.rate_paise, amountPaise,
      })
    }
    return { success: true, priced, subtotalPaise }
  }

  async quote(vendorId, input, customerUserId = input.customer?.id || input.customerId || null) {
    const items = await this._priceItems(vendorId, input.items, customerUserId)
    if (!items.success) return items
    const chargeIds = input.chargeRuleIds || []
    const discountIds = input.discountRuleIds || []
    const [chargeRules, discountRules] = await Promise.all([
      chargeIds.length ? this.adjustmentRules.findByIds(vendorId, chargeIds) : [],
      discountIds.length ? this.adjustmentRules.findByIds(vendorId, discountIds) : [],
    ])
    const subtotal = items.subtotalPaise
    const configuredCharges = chargeRules.filter((r) => r.kind === 'CHARGE').reduce((sum, rule) => sum + amountForRule(rule, subtotal), 0)
    const chargesPaise = Math.max(0, configuredCharges + Math.round((Number(input.chargesPaise) || 0)))
    const configuredDiscounts = discountRules.filter((r) => r.kind === 'DISCOUNT').reduce((sum, rule) => sum + amountForRule(rule, subtotal + chargesPaise), 0)
    const discountsPaise = Math.min(configuredDiscounts + Math.round(Number(input.discountsPaise) || 0), subtotal + chargesPaise)
    const taxablePaise = subtotal + chargesPaise - discountsPaise
    const taxRateBps = Math.max(0, Math.min(10000, Math.round((Number(input.taxRatePercent) || 0) * 100)))
    const taxPaise = Math.round(taxablePaise * taxRateBps / 10000)
    return {
      success: true,
      quote: { items: items.priced, subtotalPaise: subtotal, chargesPaise, discountsPaise, taxablePaise, taxRateBps, taxPaise, totalPaise: taxablePaise + taxPaise },
    }
  }

  // ── Booking ──────────────────────────────────────────────────────────────

  async book(vendorId, actor, input) {
    const mode = input.paymentMode ? String(input.paymentMode).toUpperCase().replace(/\s+/g, '_') : 'PAY_LATER'
    if (mode !== 'PAY_LATER' && !PAYMENT_MODES.includes(mode)) return fail(`paymentMode must be Pay Later or one of ${PAYMENT_MODES.join(', ')}`)
    if (!input.expectedDeliveryDate || Number.isNaN(Date.parse(input.expectedDeliveryDate))) return fail('An expected delivery date is required')

    let customerId = input.customer?.id
    if (!customerId) {
      const created = await this.findOrCreateCustomer(vendorId, actor, { name: input.customer?.name, phone: input.customer?.phone })
      if (!created.success) return created
      customerId = created.customer.id
    }
    const customer = (await query('SELECT id, name, phone FROM users WHERE id = $1', [customerId])).rows[0]
    if (!customer) return fail('Customer not found', 'NOT_FOUND', 404)

    const quoted = await this.quote(vendorId, input, customerId)
    if (!quoted.success) return quoted
    const q = quoted.quote

    // Using the LNDRY wallet at the POS counter is a Partner/Exclusive feature (app checkout is
    // unaffected); a Standard vendor's POS can neither redeem
    // from it nor record a sale as paid by it.
    if ((input.walletRedemption?.requestId || mode === 'WALLET') && !(await getVendorCapabilities(vendorId)).walletAccess) {
      return fail(WALLET_RESTRICTED_MESSAGE, TIER_RESTRICTED, 403)
    }

    // Wallet leg: the redemption request was already OTP-confirmed and the wallet debited.
    let walletPaise = 0
    let walletRequestId = null
    if (input.walletRedemption?.requestId) {
      const { rows } = await query(
        `SELECT id, amount_paise, status, customer_user_id FROM wallet_redemption_requests WHERE id = $1 AND vendor_id = $2`,
        [input.walletRedemption.requestId, vendorId]
      )
      const request = rows[0]
      if (!request || request.status !== 'CONFIRMED') return fail('The wallet redemption was not confirmed by the customer.', 'WALLET_NOT_CONFIRMED')
      if (request.customer_user_id !== customerId) return fail('The wallet redemption belongs to a different customer.', 'WALLET_CUSTOMER_MISMATCH')
      const used = await query('SELECT 1 FROM store_orders WHERE wallet_redemption_request_id = $1 LIMIT 1', [request.id])
      if (used.rows.length) return fail('This wallet redemption was already applied to an order.', 'WALLET_ALREADY_USED')
      walletPaise = Math.min(request.amount_paise, q.totalPaise)
      walletRequestId = request.id
    }
    // 'WALLET' as the payment mode is only real when a confirmed redemption covers the whole sale;
    // otherwise it would record a wallet payment that no wallet was ever debited for.
    if (mode === 'WALLET' && walletPaise < q.totalPaise) return fail('Pay with the wallet only after the customer has confirmed a redemption that covers the full amount.', 'WALLET_NOT_CONFIRMED')
    const cashPaise = mode === 'PAY_LATER' ? 0 : Math.max(0, q.totalPaise - walletPaise)
    const paidPaise = walletPaise + cashPaise

    let cashShiftId = null
    if (mode === 'CASH') {
      const shift = await this.cashShifts.findOpen(vendorId, input.cashRegister || 'Main counter')
      cashShiftId = shift?.id ?? null
    }

    const orderNumber = `LND-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const orderId = randomUUID()
    const bulkWeightKg = q.items.filter((i) => !PIECE_UNITS.has(String(i.unit).toLowerCase())).reduce((sum, i) => sum + i.qty, 0)
    const hasBulk = q.items.some((i) => !PIECE_UNITS.has(String(i.unit).toLowerCase()))

    const client = await getClient()
    const tags = []
    const containerTags = []
    let order
    try {
      await client.query('BEGIN')
      const insert = await client.query(
        `INSERT INTO store_orders (
           id, vendor_id, customer_user_id, pos_order_id, order_number, items,
           subtotal_paise, discount_paise, charges_paise, tax_paise, tax_rate_bps, total_paise,
           payment_method, amount_paid_paise, payment_reference, wallet_amount_paise, wallet_redemption_request_id,
           cash_shift_id, status, source, order_date, expected_delivery_date, fulfillment_mode, delivery_address,
           service_zone, notes, photo_path, app_synced
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'BOOKED','COUNTER',$19,$20,$21,$22,$23,$24,$25,
           COALESCE((SELECT v.vendor_type IN ('PARTNER', 'EXCLUSIVE') FROM vendors v WHERE v.id = $2), FALSE))
         RETURNING id`,
        [
          orderId, vendorId, customerId, String(input.idempotencyKey || `CO-${orderId}`), orderNumber, JSON.stringify(q.items),
          q.subtotalPaise, q.discountsPaise, q.chargesPaise, q.taxPaise, q.taxRateBps, q.totalPaise,
          mode === 'PAY_LATER' ? (walletPaise ? 'WALLET' : null) : mode, paidPaise, input.paymentReference ? String(input.paymentReference).slice(0, 120) : null,
          walletPaise, walletRequestId, cashShiftId,
          input.orderDate || new Date().toISOString().slice(0, 10), input.expectedDeliveryDate, input.fulfillmentMode || null,
          input.deliveryAddress || null, input.serviceZone || null, input.notes ? String(input.notes).slice(0, 1000) : null, input.photoPath || null,
        ]
      )

      if (walletPaise > 0) {
        await client.query(
          `INSERT INTO store_order_payments (store_order_id, vendor_id, amount_paise, mode, reference, created_by) VALUES ($1,$2,$3,'WALLET',$4,$5)`,
          [orderId, vendorId, walletPaise, walletRequestId, actor.userId]
        )
      }
      if (cashPaise > 0) {
        await client.query(
          `INSERT INTO store_order_payments (store_order_id, vendor_id, amount_paise, mode, reference, cash_shift_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orderId, vendorId, cashPaise, mode, input.paymentReference || null, cashShiftId, actor.userId]
        )
      }

      // Garment tags for piece lines; bag tags for weight-billed lines.
      for (let index = 0; index < q.items.length; index += 1) {
        const line = q.items[index]
        if (!PIECE_UNITS.has(String(line.unit).toLowerCase())) continue
        for (let sequence = 1; sequence <= line.qty; sequence += 1) {
          const tagCode = tag('ELT')
          const unit = (await client.query(
            `INSERT INTO vendor_garment_units (vendor_id, order_id, order_line_id, store_line_index, customer_user_id, garment_type_id, garment_name, sequence, active_tag_code, created_by)
             VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [vendorId, orderId, index, customerId, line.garmentTypeId, line.name, sequence, tagCode, actor.userId]
          )).rows[0]
          await client.query('INSERT INTO vendor_garment_tag_history (unit_id, tag_code, issued_by) VALUES ($1,$2,$3)', [unit.id, tagCode, actor.userId])
          await client.query(
            `INSERT INTO vendor_garment_unit_events (unit_id, event_type, to_state, location, actor_id, note) VALUES ($1,'CREATED','INTAKE','Intake',$2,'Created at counter booking')`,
            [unit.id, actor.userId]
          )
          tags.push({
            unitId: unit.id, tagNumber: tagCode, tagKind: 'garment', orderNumber, customer: customer.name || customer.phone,
            garment: line.name, service: line.serviceName, category: line.categoryName || undefined, sequence, total: line.qty,
            orderDate: input.orderDate || new Date().toISOString().slice(0, 10), expectedDeliveryDate: input.expectedDeliveryDate,
          })
        }
      }
      if (hasBulk) {
        const count = Math.max(1, Math.min(50, Math.trunc(Number(input.containerCount) || 1)))
        for (let sequence = 1; sequence <= count; sequence += 1) {
          const tagCode = tag('ELB')
          const container = (await client.query(
            `INSERT INTO vendor_laundry_containers (vendor_id, order_id, customer_user_id, tag_code, sequence, total_count, weight_kg, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [vendorId, orderId, customerId, tagCode, sequence, count, count === 1 ? Math.round(bulkWeightKg * 100) / 100 : null, actor.userId]
          )).rows[0]
          await client.query(
            `INSERT INTO vendor_laundry_container_events (container_id, event_type, to_state, location, actor_id, note) VALUES ($1,'CREATED','INTAKE','Intake',$2,'Created at counter booking')`,
            [container.id, actor.userId]
          )
          containerTags.push({
            containerId: container.id, tagNumber: tagCode, tagKind: 'container', orderNumber, customer: customer.name || customer.phone,
            garment: 'Bag', service: 'Bulk laundry', sequence, total: count, weightKg: count === 1 ? bulkWeightKg : undefined,
            orderDate: input.orderDate || new Date().toISOString().slice(0, 10), expectedDeliveryDate: input.expectedDeliveryDate,
          })
        }
      }
      await client.query('COMMIT')
      void insert
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    // Post-commit bookkeeping — a failure here never loses the booked order.
    try {
      for (const unit of tags) {
        await this.productionTasks.onGarmentUnitTransitioned(vendorId, actor.userId, { garmentUnitId: unit.unitId, orderId, nextState: 'INTAKE', note: 'Created at counter booking' })
      }
      const reason = `Counter order ${orderNumber}`
      await this.ledger.append(vendorId, actor, { customerUserId: customerId, entryType: 'INVOICE_DEBIT', debitPaise: q.totalPaise, referenceType: 'store_order', referenceId: orderId, reason })
      if (paidPaise > 0) {
        await this.ledger.append(vendorId, actor, { customerUserId: customerId, entryType: 'PAYMENT_CREDIT', creditPaise: paidPaise, referenceType: 'store_order', referenceId: orderId, reason: `Payment for ${orderNumber}` })
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('counter order bookkeeping failed', error)
    }

    emitAudit('vendor_counter_order_booked', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'store_order', target_id: orderId,
      before: null, after: { orderNumber, totalPaise: q.totalPaise, paymentMode: mode }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    order = await this.getOrder(vendorId, orderId)
    return { success: true, order, quote: q, tags, containerTags, customer }
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  async listOrders(vendorId, { status, search, from, to, customerId, limit = 100 } = {}) {
    const params = [vendorId]
    const where = ['so.vendor_id = $1', "so.source <> 'DESKTOP_PUSH'"]
    if (status) { params.push(String(status).toUpperCase()); where.push(`so.status = $${params.length}`) }
    if (customerId) { params.push(customerId); where.push(`so.customer_user_id = $${params.length}`) }
    if (from) { params.push(from); where.push(`so.placed_at >= $${params.length}::date`) }
    if (to) { params.push(to); where.push(`so.placed_at < ($${params.length}::date + 1)`) }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`)
      const n = params.length
      where.push(`(lower(so.order_number) LIKE $${n} OR lower(COALESCE(u.name,'')) LIKE $${n} OR u.phone LIKE $${n})`)
    }
    params.push(Math.min(Number(limit) || 100, 500))
    const { rows } = await query(`SELECT ${ORDER_SELECT} ${ORDER_FROM} WHERE ${where.join(' AND ')} ORDER BY so.placed_at DESC LIMIT $${params.length}`, params)
    return rows.map(presentOrder)
  }

  async getOrder(vendorId, id) {
    const { rows } = await query(`SELECT ${ORDER_SELECT} ${ORDER_FROM} WHERE so.vendor_id = $1 AND so.id = $2`, [vendorId, id])
    return rows[0] ? presentOrder(rows[0]) : null
  }

  async getDetail(vendorId, id) {
    const order = await this.getOrder(vendorId, id)
    if (!order) return null
    const [units, containers, payments] = await Promise.all([
      query(
        `SELECT gu.id, gu.active_tag_code, gu.sequence, gu.store_line_index, gu.state, gu.location, gu.condition, gu.created_at, gu.updated_at, COALESCE(gu.garment_name, gt.name) AS garment_name
         FROM vendor_garment_units gu LEFT JOIN garment_types gt ON gt.id = gu.garment_type_id
         WHERE gu.vendor_id = $1 AND gu.order_id = $2 ORDER BY gu.store_line_index, gu.sequence`, [vendorId, id]),
      query(
        `SELECT id, tag_code, sequence, total_count, weight_kg, state, location, condition, created_at, updated_at, delivered_at
         FROM vendor_laundry_containers WHERE vendor_id = $1 AND order_id = $2 ORDER BY sequence`, [vendorId, id]),
      this.listPayments(vendorId, id),
    ])
    return {
      order,
      units: units.rows.map((u) => ({ id: u.id, tagCode: u.active_tag_code, sequence: u.sequence, itemIndex: u.store_line_index, state: u.state, location: u.location, condition: u.condition, garmentName: u.garment_name, createdAt: u.created_at, updatedAt: u.updated_at })),
      containers: containers.rows.map((c) => ({ id: c.id, tagCode: c.tag_code, sequence: c.sequence, total: c.total_count, weightKg: c.weight_kg == null ? null : Number(c.weight_kg), state: c.state, location: c.location, condition: c.condition, createdAt: c.created_at, updatedAt: c.updated_at, deliveredAt: c.delivered_at })),
      payments,
    }
  }

  async listPayments(vendorId, orderId) {
    const { rows } = await query(
      `SELECT id, amount_paise, mode, reference, created_at FROM store_order_payments WHERE vendor_id = $1 AND store_order_id = $2 ORDER BY created_at`,
      [vendorId, orderId]
    )
    return rows.map((r) => ({ id: r.id, amountPaise: r.amount_paise, mode: r.mode, reference: r.reference, createdAt: r.created_at }))
  }

  // ── Changing an order ────────────────────────────────────────────────────

  async update(vendorId, actor, id, patch) {
    const order = await this.getOrder(vendorId, id)
    if (!order) return fail('Order not found', 'NOT_FOUND', 404)
    if (['DELIVERED', 'CANCELLED'].includes(order.status)) return fail('A delivered or cancelled order can no longer be edited', 'ORDER_CLOSED', 409)
    if (patch.version !== undefined && patch.version !== order.version) return fail('This order was changed by someone else. Reload and try again.', 'VERSION_CONFLICT', 409)
    const { rows } = await query(
      `UPDATE store_orders SET
         notes = COALESCE($3, notes), expected_delivery_date = COALESCE($4::date, expected_delivery_date),
         delivery_address = COALESCE($5, delivery_address), service_zone = COALESCE($6, service_zone),
         fulfillment_mode = COALESCE($7, fulfillment_mode), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2 RETURNING id`,
      [id, vendorId, patch.notes ?? null, patch.expectedDeliveryDate ?? null, patch.deliveryAddress ?? null, patch.serviceZone ?? null, patch.fulfillmentMode ?? null]
    )
    if (!rows[0]) return fail('Order not found', 'NOT_FOUND', 404)
    return { success: true, order: await this.getOrder(vendorId, id) }
  }

  async transition(vendorId, actor, id, targetState, extra = {}) {
    const target = String(targetState || '').toUpperCase().replace(/\s+/g, '_')
    if (!STATES.includes(target)) return fail('Unknown order state')
    const order = await this.getOrder(vendorId, id)
    if (!order) return fail('Order not found', 'NOT_FOUND', 404)
    if (extra.version !== undefined && extra.version !== order.version) return fail('This order was changed by someone else. Reload and try again.', 'VERSION_CONFLICT', 409)
    if (!NEXT_STATES[order.status]?.includes(target)) return fail(`An order that is ${order.status.replace(/_/g, ' ').toLowerCase()} cannot move to ${target.replace(/_/g, ' ').toLowerCase()}`, 'INVALID_TRANSITION', 409)
    if (target === 'CANCELLED') return this.cancel(vendorId, actor, id, extra.reason)

    if (target === 'READY') {
      const { rows } = await query(
        `SELECT
           (SELECT COUNT(*) FROM vendor_garment_units WHERE vendor_id = $1 AND order_id = $2 AND state = ANY($3::text[]))::int AS garments,
           (SELECT COUNT(*) FROM vendor_laundry_containers WHERE vendor_id = $1 AND order_id = $2 AND state IN ('INTAKE','MISSING'))::int AS bags`,
        [vendorId, id, NOT_READY_UNIT_STATES]
      )
      const { garments, bags } = rows[0]
      if (garments > 0) return fail(`${garments} garment(s) have not reached assembly yet — scan them through processing first.`, 'ASSEMBLY_INCOMPLETE', 409)
      if (bags > 0) return fail(`${bags} bag(s) are still at intake — scan them into processing first.`, 'ASSEMBLY_INCOMPLETE', 409)
    }
    if (target === 'DELIVERED' && order.paymentStatus !== 'PAID' && !extra.allowUnpaid) {
      return fail('This order still has an outstanding balance. Collect payment first.', 'PAYMENT_OUTSTANDING', 409)
    }
    await query('UPDATE store_orders SET status = $3, version = version + 1, updated_at = NOW() WHERE id = $1 AND vendor_id = $2', [id, vendorId, target])
    if (target === 'DELIVERED') {
      await query(`UPDATE vendor_garment_units SET state = 'DELIVERED', updated_at = NOW() WHERE vendor_id = $1 AND order_id = $2 AND state IN ('ASSEMBLY','RACKED','DISPATCHED')`, [vendorId, id])
      await query(`UPDATE vendor_laundry_containers SET state = 'DELIVERED', delivered_at = NOW(), updated_at = NOW() WHERE vendor_id = $1 AND order_id = $2 AND state IN ('READY','DISPATCHED','PROCESSING')`, [vendorId, id])
      scheduleInvoiceForDeliveredOrder(id)
    }
    emitAudit('vendor_counter_order_transitioned', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'store_order', target_id: id,
      before: { status: order.status }, after: { status: target }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, order: await this.getOrder(vendorId, id) }
  }

  async cancel(vendorId, actor, id, reason) {
    const order = await this.getOrder(vendorId, id)
    if (!order) return fail('Order not found', 'NOT_FOUND', 404)
    if (['DELIVERED', 'CANCELLED'].includes(order.status)) return fail('This order can no longer be cancelled', 'INVALID_TRANSITION', 409)
    const why = String(reason || '').trim()
    if (why.length < 3) return fail('Give a reason for cancelling this order')
    await query(`UPDATE store_orders SET status = 'CANCELLED', cancel_reason = $3, version = version + 1, updated_at = NOW() WHERE id = $1 AND vendor_id = $2`, [id, vendorId, why.slice(0, 500)])
    await query(`UPDATE vendor_garment_units SET state = 'CANCELLED', updated_at = NOW() WHERE vendor_id = $1 AND order_id = $2 AND state NOT IN ('DELIVERED')`, [vendorId, id])
    await query(`UPDATE vendor_laundry_containers SET state = 'CANCELLED', updated_at = NOW() WHERE vendor_id = $1 AND order_id = $2 AND state NOT IN ('DELIVERED')`, [vendorId, id])
    emitAudit('vendor_counter_order_cancelled', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'store_order', target_id: id,
      before: { status: order.status }, after: { status: 'CANCELLED', reason: why }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, order: await this.getOrder(vendorId, id) }
  }

  async assign(vendorId, actor, id, { pickupRiderId, deliveryRiderId }) {
    const order = await this.getOrder(vendorId, id)
    if (!order) return fail('Order not found', 'NOT_FOUND', 404)
    const ids = [pickupRiderId, deliveryRiderId].filter(Boolean)
    if (ids.length) {
      const { rows } = await query(`SELECT id FROM vendor_employees WHERE vendor_id = $1 AND id = ANY($2::uuid[]) AND is_active = true`, [vendorId, ids])
      if (rows.length !== new Set(ids).size) return fail('That captain is not active on your team', 'NOT_FOUND', 404)
    }
    await query(
      `UPDATE store_orders SET pickup_rider_employee_id = COALESCE($3::uuid, pickup_rider_employee_id),
         delivery_rider_employee_id = COALESCE($4::uuid, delivery_rider_employee_id), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND vendor_id = $2`,
      [id, vendorId, pickupRiderId || null, deliveryRiderId || null]
    )
    return { success: true, order: await this.getOrder(vendorId, id) }
  }

  async collectPayment(vendorId, actor, id, { amountPaise, mode, reference, cashRegister }) {
    const order = await this.getOrder(vendorId, id)
    if (!order) return fail('Order not found', 'NOT_FOUND', 404)
    if (order.status === 'CANCELLED') return fail('A cancelled order cannot take payment', 'ORDER_CLOSED', 409)
    const payMode = String(mode || '').toUpperCase()
    if (!PAYMENT_MODES.includes(payMode) || payMode === 'WALLET') return fail(`Payment mode must be one of ${PAYMENT_MODES.filter((m) => m !== 'WALLET').join(', ')}`)
    const amount = Math.round(Number(amountPaise))
    if (!Number.isFinite(amount) || amount <= 0) return fail('Enter an amount greater than zero')
    const outstanding = order.totalPaise - order.amountPaidPaise
    if (amount > outstanding) return fail(`Only ₹${(outstanding / 100).toFixed(2)} is outstanding on this order`, 'OVERPAYMENT')
    let cashShiftId = null
    if (payMode === 'CASH') {
      const shift = await this.cashShifts.findOpen(vendorId, cashRegister || 'Main counter')
      cashShiftId = shift?.id ?? null
    }
    await query(
      `INSERT INTO store_order_payments (store_order_id, vendor_id, amount_paise, mode, reference, cash_shift_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, vendorId, amount, payMode, reference ? String(reference).slice(0, 120) : null, cashShiftId, actor.userId]
    )
    await query('UPDATE store_orders SET amount_paid_paise = amount_paid_paise + $3, version = version + 1, updated_at = NOW() WHERE id = $1 AND vendor_id = $2', [id, vendorId, amount])
    await this.ledger.append(vendorId, actor, { customerUserId: order.customer.id, entryType: 'PAYMENT_CREDIT', creditPaise: amount, referenceType: 'store_order', referenceId: id, reason: `${payMode} payment for ${order.orderNumber}` }).catch(() => null)
    emitAudit('vendor_counter_order_payment', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'store_order', target_id: id,
      before: null, after: { amountPaise: amount, mode: payMode }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, order: await this.getOrder(vendorId, id), payments: await this.listPayments(vendorId, id) }
  }

  // ── Cross-order tag views ────────────────────────────────────────────────

  async listGarmentUnits(vendorId, { orderId, state, search, limit = 300 } = {}) {
    const params = [vendorId]
    const where = ['gu.vendor_id = $1']
    if (orderId) { params.push(orderId); where.push(`gu.order_id = $${params.length}`) }
    if (state) { params.push(String(state).toUpperCase()); where.push(`gu.state = $${params.length}`) }
    if (search) { params.push(`%${String(search).toLowerCase()}%`); where.push(`(lower(gu.active_tag_code) LIKE $${params.length} OR lower(COALESCE(gu.garment_name, gt.name, '')) LIKE $${params.length})`) }
    params.push(Math.min(Number(limit) || 300, 1000))
    const { rows } = await query(
      `SELECT gu.id, gu.order_id, gu.active_tag_code, gu.sequence, gu.store_line_index, gu.state, gu.location, gu.condition, gu.created_at, gu.updated_at,
              COALESCE(gu.garment_name, gt.name) AS garment_name, so.order_number, so.expected_delivery_date, so.items, cu.name AS customer_name, cu.phone AS customer_phone
       FROM vendor_garment_units gu
       LEFT JOIN garment_types gt ON gt.id = gu.garment_type_id
       LEFT JOIN store_orders so ON so.id = gu.order_id
       LEFT JOIN users cu ON cu.id = gu.customer_user_id
       WHERE ${where.join(' AND ')} ORDER BY gu.created_at DESC, gu.sequence LIMIT $${params.length}`,
      params
    )
    return rows.map((r) => ({
      id: r.id, orderId: r.order_id, orderNumber: r.order_number, tagCode: r.active_tag_code, sequence: r.sequence, itemIndex: r.store_line_index,
      garmentName: r.garment_name, serviceName: r.items?.[r.store_line_index]?.serviceName || '', state: r.state, location: r.location, condition: r.condition,
      customerName: r.customer_name || '', customerPhone: r.customer_phone || '',
      expectedDeliveryDate: dateOnly(r.expected_delivery_date), createdAt: r.created_at, updatedAt: r.updated_at,
    }))
  }

  async listContainers(vendorId, { orderId, state, limit = 300 } = {}) {
    const params = [vendorId]
    const where = ['c.vendor_id = $1']
    if (orderId) { params.push(orderId); where.push(`c.order_id = $${params.length}`) }
    if (state) { params.push(String(state).toUpperCase()); where.push(`c.state = $${params.length}`) }
    params.push(Math.min(Number(limit) || 300, 1000))
    const { rows } = await query(
      `SELECT c.id, c.order_id, c.tag_code, c.sequence, c.total_count, c.weight_kg, c.state, c.location, c.condition, c.created_at, c.updated_at, c.delivered_at,
              so.order_number, so.expected_delivery_date, cu.name AS customer_name, cu.phone AS customer_phone
       FROM vendor_laundry_containers c
       LEFT JOIN store_orders so ON so.id = c.order_id
       LEFT JOIN users cu ON cu.id = c.customer_user_id
       WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.sequence LIMIT $${params.length}`,
      params
    )
    return rows.map((r) => ({
      id: r.id, orderId: r.order_id, orderNumber: r.order_number, tagCode: r.tag_code, sequence: r.sequence, total: r.total_count,
      weightKg: r.weight_kg == null ? null : Number(r.weight_kg), state: r.state, location: r.location, condition: r.condition,
      customerName: r.customer_name || '', customerPhone: r.customer_phone || '',
      expectedDeliveryDate: dateOnly(r.expected_delivery_date),
      createdAt: r.created_at, updatedAt: r.updated_at, deliveredAt: r.delivered_at,
    }))
  }
}
