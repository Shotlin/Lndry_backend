import { query } from '../../config/database.js'

/**
 * Invoice data builder — the ONLY place an invoice's numbers are worked out.
 *
 * It reads the real, final order + payment rows and returns a plain,
 * self-contained "invoice data" object (all money in integer paise). That
 * object is frozen into `invoices.snapshot` and handed to a template, which
 * only formats it. Neither the mobile app nor a template ever calculates a
 * total, so changing a template can never change what a customer owes.
 *
 * Two kinds of order can be invoiced, both normalised to the same shape:
 *   ORDER        — a pickup-and-delivery order (`orders` + `order_lines`)
 *   STORE_ORDER  — an in-person counter order (`store_orders`)
 */

export const INVOICE_SCHEMA_VERSION = 1

/** Units priced by a continuous measurement (see utils/order-recalculation.js). */
const CONTINUOUS_UNITS = new Set(['kg', 'sqft'])

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100)
const int = (value) => Math.round(Number(value || 0))

function parseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const pick = (obj, ...keys) => {
  for (const key of keys) {
    if (obj?.[key] != null && obj[key] !== '') return obj[key]
  }
  return null
}

/** "12 MG Road, Landmark, Kolkata, West Bengal - 700001" from any of the address shapes we store. */
export function formatAddress(raw) {
  const a = typeof raw === 'string' ? parseJson(raw, null) ?? { text: raw } : raw
  if (!a || typeof a !== 'object') return { lines: [], text: '' }
  if (a.text && typeof a.text === 'string') return { lines: [a.text], text: a.text }

  const line1 = pick(a, 'address_line1', 'addressLine1', 'line1', 'address_line')
  const line2 = pick(a, 'address_line2', 'addressLine2', 'line2')
  const landmark = pick(a, 'landmark')
  const city = pick(a, 'city')
  const state = pick(a, 'state')
  const pincode = pick(a, 'pincode', 'pin_code', 'postalCode')

  const lines = [
    [line1, line2].filter(Boolean).join(', '),
    landmark ? `Near ${landmark}` : '',
    [city, state].filter(Boolean).join(', ') + (pincode ? ` - ${pincode}` : ''),
  ].filter((l) => l && l.trim() && l.trim() !== '-')
  return { lines, text: lines.join(', ') }
}

/** Indian financial year label for a date, e.g. 2026-09-19 -> "2627". */
export function financialYearLabel(date) {
  const ist = new Date(new Date(date).getTime() + 5.5 * 3600 * 1000)
  const year = ist.getUTCFullYear()
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1 // April starts the FY
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`
}

async function loadCompany() {
  const { rows } = await query(
    `SELECT key, value FROM app_settings WHERE key IN ('support_phone', 'support_email')`
  )
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    name: 'LNDRY',
    tagline: 'Laundry & dry cleaning, picked up and delivered',
    supportPhone: text(settings.support_phone),
    supportEmail: text(settings.support_email),
    // Deliberately no company GSTIN here: the only value on file is the
    // scaffold's placeholder (app_settings.store_gstin). Add it once the real
    // registration number is set, then print it from the template.
  }
}

async function loadCustomer(userId, addressRaw) {
  const { rows } = await query(`SELECT id, name, phone, email FROM users WHERE id = $1`, [userId])
  const u = rows[0] || {}
  const address = formatAddress(addressRaw)
  return {
    id: userId,
    name: u.name || 'Customer',
    phone: u.phone || null,
    email: u.email || null,
    address,
  }
}

async function loadVendor(vendorId) {
  if (!vendorId) return null
  const { rows } = await query(
    `SELECT id, name, phone, email, address_line1, address_line2, city, state, pincode, gst_number
       FROM vendors WHERE id = $1`,
    [vendorId]
  )
  const v = rows[0]
  if (!v) return null
  return {
    id: v.id,
    name: v.name,
    phone: v.phone || null,
    email: v.email || null,
    gstin: v.gst_number || null,
    address: formatAddress(v),
  }
}

function describeQuantity(quantity, unit) {
  const u = String(unit || 'piece').toLowerCase()
  const qty = Number.isInteger(quantity) ? String(quantity) : String(Math.round(quantity * 100) / 100)
  if (u === 'piece' || u === 'pc' || u === 'item') return `${qty} ${quantity === 1 ? 'pc' : 'pcs'}`
  if (u === 'sqft') return `${qty} sq ft`
  return `${qty} ${u}`
}

/** Pulls the payment picture out of PAID `payments` rows (advance / final / total). */
function summarisePayments({ payments, totalPaise, orderPaymentStatus, orderPaymentMethod }) {
  const paid = payments.filter((p) => p.amountPaise > 0)
  const advancePaise = paid
    .filter((p) => p.purpose === 'ADVANCE' || p.purpose === 'FULL')
    .reduce((s, p) => s + p.amountPaise, 0)
  const finalPaise = paid.filter((p) => p.purpose === 'BALANCE').reduce((s, p) => s + p.amountPaise, 0)
  const paidPaise = advancePaise + finalPaise

  // A delivered order the system already marks PAID is settled even if the
  // individual rows don't add up (e.g. cash collected before payment rows
  // were recorded) — never show such a customer a balance due.
  const settled = paidPaise >= totalPaise || orderPaymentStatus === 'PAID'
  const balanceDuePaise = settled ? 0 : Math.max(totalPaise - paidPaise, 0)
  const status = settled ? 'PAID' : paidPaise > 0 ? 'PARTIALLY_PAID' : 'UNPAID'

  return {
    status,
    method: orderPaymentMethod || null,
    advancePaise,
    finalPaise,
    paidPaise: settled ? Math.max(paidPaise, totalPaise) : paidPaise,
    balanceDuePaise,
    payments: paid.map((p) => ({
      purpose: p.purpose,
      method: p.method || null,
      amountPaise: p.amountPaise,
      paidAt: p.paidAt,
    })),
  }
}

// ── Order lookup ─────────────────────────────────────────────────────────────

/**
 * Finds which kind of order an id is and who owns it. Returns null if the id
 * is neither. Ids are UUIDs, so the two tables can't collide.
 */
export async function resolveOrderRef(orderId) {
  const order = await query(`SELECT id, user_id, vendor_id, status FROM orders WHERE id = $1`, [orderId])
  if (order.rows[0]) {
    const r = order.rows[0]
    return { type: 'ORDER', id: r.id, customerId: r.user_id, vendorId: r.vendor_id, status: r.status }
  }
  const store = await query(
    `SELECT id, customer_user_id, vendor_id, status, app_synced FROM store_orders WHERE id = $1`,
    [orderId]
  )
  if (store.rows[0]) {
    const r = store.rows[0]
    return { type: 'STORE_ORDER', id: r.id, customerId: r.customer_user_id, vendorId: r.vendor_id, status: r.status, appSynced: r.app_synced }
  }
  return null
}

/** Only a finished order is invoiced. */
export const isInvoiceable = (ref) => ref?.status === 'DELIVERED'

// ── Pickup-and-delivery order ────────────────────────────────────────────────

async function buildFromOrder(ref) {
  const { rows } = await query(
    `SELECT id, order_number, user_id, vendor_id, status, items, subtotal, discount_amount,
            delivery_fee, platform_fee, handling_fee, tax_amount, total_amount, payable_amount_paise,
            payment_method, payment_status, coupon_code, delivery_address, fee_breakdown,
            delivered_at, created_at, updated_at
       FROM orders WHERE id = $1`,
    [ref.id]
  )
  const o = rows[0]
  if (!o) return null

  const [linesRes, paymentsRes, customer, vendor, company] = await Promise.all([
    query(
      `SELECT name, unit, price, quantity, total, rate_paise, total_paise, confirmed_quantity
         FROM order_lines WHERE order_id = $1 ORDER BY created_at ASC`,
      [o.id]
    ),
    query(
      `SELECT purpose, method, amount, created_at
         FROM payments WHERE order_id = $1 AND status = 'PAID' ORDER BY created_at ASC`,
      [o.id]
    ),
    loadCustomer(o.user_id, o.delivery_address),
    loadVendor(o.vendor_id),
    loadCompany(),
  ])

  // Lines: order_lines is the live truth (kept correct through weigh-in /
  // re-evaluation); the checkout-time JSON snapshot is only the fallback for
  // older orders that predate it.
  let lines = linesRes.rows.map((l) => {
    const ratePaise = l.rate_paise ?? toPaise(l.price)
    const amountPaise = l.total_paise ?? toPaise(l.total)
    const unit = String(l.unit || 'piece').toLowerCase()
    // A weight/area-corrected line stores the sentinel quantity 1; its real
    // measurement is amount / rate (see order-recalculation.js).
    const quantity =
      CONTINUOUS_UNITS.has(unit) && ratePaise > 0
        ? amountPaise / ratePaise
        : Number(l.confirmed_quantity ?? l.quantity ?? 1)
    return { description: l.name, unit, quantity, ratePaise, amountPaise }
  })
  if (lines.length === 0) {
    lines = parseJson(o.items, []).map((it) => {
      const quantity = Number(it.quantity ?? it.qty ?? 1)
      const ratePaise = toPaise(it.price)
      return {
        description: it.name || it.productName || 'Item',
        unit: String(it.unit || 'piece').toLowerCase(),
        quantity,
        ratePaise,
        amountPaise: it.total != null ? toPaise(it.total) : Math.round(ratePaise * quantity),
      }
    })
  }
  lines = lines.map((l) => ({ ...l, quantityLabel: describeQuantity(l.quantity, l.unit) }))
  const subtotalPaise = lines.reduce((s, l) => s + l.amountPaise, 0)

  const fb = parseJson(o.fee_breakdown, {}) || {}
  const canonical = fb.canonical_breakdown || {}
  const totalPaise = o.payable_amount_paise ? int(o.payable_amount_paise) : toPaise(o.total_amount)

  // After a re-evaluation the payable is recomputed as subtotal + delivery +
  // platform fee only (utils/order-recalculation.js) — tax, discount and the
  // express fee are NOT part of what the customer was finally charged, so
  // they must not be printed as if they were.
  const reEvaluated = fb.original_subtotal_paise != null
  const deliveryFeePaise = int(fb.delivery_fee_paise ?? toPaise(o.delivery_fee))
  const platformFeePaise = int(fb.platform_fee_paise ?? toPaise(Number(o.platform_fee || 0) + Number(o.handling_fee || 0)))
  const expressFeePaise = reEvaluated ? 0 : int(fb.express_fee_paise)
  const taxPaise = reEvaluated ? 0 : int(fb.tax_paise ?? toPaise(o.tax_amount))
  const discountPaise = reEvaluated ? 0 : int(fb.discount_paise ?? toPaise(o.discount_amount))

  const computedPaise = subtotalPaise + deliveryFeePaise + platformFeePaise + expressFeePaise + taxPaise - discountPaise
  // Whatever the components don't explain (rounding, legacy data) is shown
  // openly as an adjustment, so the printed lines always add up to the total.
  const adjustmentPaise = totalPaise - computedPaise

  const payment = summarisePayments({
    payments: paymentsRes.rows.map((p) => ({
      purpose: p.purpose,
      method: p.method,
      amountPaise: toPaise(p.amount),
      paidAt: p.created_at,
    })),
    totalPaise,
    orderPaymentStatus: o.payment_status,
    orderPaymentMethod: o.payment_method,
  })

  const deliveredAt = o.delivered_at || o.updated_at || o.created_at
  return {
    schemaVersion: INVOICE_SCHEMA_VERSION,
    invoice: { currency: 'INR', invoiceDate: new Date(deliveredAt).toISOString() },
    order: {
      id: o.id,
      type: 'ORDER',
      number: o.order_number || null,
      status: o.status,
      placedAt: new Date(o.created_at).toISOString(),
      deliveredAt: new Date(deliveredAt).toISOString(),
    },
    company,
    customer,
    vendor,
    lines,
    totals: {
      subtotalPaise,
      deliveryFeePaise,
      platformFeePaise,
      expressFeePaise,
      discountPaise,
      couponCode: reEvaluated ? null : o.coupon_code || null,
      taxPaise,
      taxLabel: canonical.taxLabel || 'GST',
      adjustmentPaise,
      totalPaise,
    },
    payment,
  }
}

// ── In-person counter order ──────────────────────────────────────────────────

async function buildFromStoreOrder(ref) {
  const { rows } = await query(
    `SELECT id, order_number, customer_user_id, vendor_id, status, items, subtotal_paise, charges_paise,
            discount_paise, tax_paise, tax_rate_bps, total_paise, payment_method, amount_paid_paise,
            delivery_address, source, placed_at, updated_at
       FROM store_orders WHERE id = $1`,
    [ref.id]
  )
  const o = rows[0]
  if (!o) return null

  const [paymentsRes, customer, vendor, company] = await Promise.all([
    query(
      `SELECT mode, amount_paise, created_at FROM store_order_payments WHERE store_order_id = $1 ORDER BY created_at ASC`,
      [o.id]
    ),
    loadCustomer(o.customer_user_id, o.delivery_address),
    loadVendor(o.vendor_id),
    loadCompany(),
  ])

  const lines = parseJson(o.items, []).map((it) => {
    const quantity = Number(it.qty ?? it.quantity ?? 1)
    const unit = String(it.unit || 'piece').toLowerCase()
    return {
      description: [it.name, it.serviceName].filter(Boolean).join(' — ') || 'Item',
      unit,
      quantity,
      ratePaise: int(it.ratePaise),
      amountPaise: int(it.amountPaise ?? Math.round(int(it.ratePaise) * quantity)),
      quantityLabel: describeQuantity(quantity, unit),
    }
  })
  const subtotalPaise = int(o.subtotal_paise) || lines.reduce((s, l) => s + l.amountPaise, 0)
  const totalPaise = int(o.total_paise)
  const platformFeePaise = int(o.charges_paise) // counter "service charges"
  const taxPaise = int(o.tax_paise)
  const discountPaise = int(o.discount_paise)
  const adjustmentPaise = totalPaise - (subtotalPaise + platformFeePaise + taxPaise - discountPaise)

  let payments = paymentsRes.rows.map((p) => ({
    purpose: 'FULL',
    method: p.mode,
    amountPaise: int(p.amount_paise),
    paidAt: p.created_at,
  }))
  // Older rows pushed by the desktop sync carry only a paid amount + method.
  if (payments.length === 0 && int(o.amount_paid_paise) > 0) {
    payments = [{ purpose: 'FULL', method: o.payment_method, amountPaise: int(o.amount_paid_paise), paidAt: o.placed_at }]
  }
  const payment = summarisePayments({
    payments,
    totalPaise,
    orderPaymentStatus: null,
    orderPaymentMethod: o.payment_method,
  })

  const invoiceDate = o.source === 'DESKTOP_PUSH' ? o.placed_at : o.updated_at || o.placed_at
  return {
    schemaVersion: INVOICE_SCHEMA_VERSION,
    invoice: { currency: 'INR', invoiceDate: new Date(invoiceDate).toISOString() },
    order: {
      id: o.id,
      type: 'STORE_ORDER',
      number: o.order_number || null,
      status: o.status,
      placedAt: new Date(o.placed_at).toISOString(),
      deliveredAt: new Date(invoiceDate).toISOString(),
    },
    company,
    customer,
    vendor,
    lines,
    totals: {
      subtotalPaise,
      deliveryFeePaise: 0,
      platformFeePaise,
      expressFeePaise: 0,
      discountPaise,
      couponCode: null,
      taxPaise,
      taxLabel: 'GST',
      taxRatePercent: o.tax_rate_bps ? o.tax_rate_bps / 100 : null,
      adjustmentPaise,
      totalPaise,
    },
    payment,
  }
}

/** Builds the invoice data for a resolved order ref (see resolveOrderRef). */
export async function buildInvoiceData(ref) {
  return ref.type === 'STORE_ORDER' ? buildFromStoreOrder(ref) : buildFromOrder(ref)
}
