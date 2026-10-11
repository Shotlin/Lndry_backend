#!/usr/bin/env node
/**
 * POS counter smoke test — drives the REAL HTTP API the Vendor App's POS mode uses.
 *
 *   OTP login → POS onboarding → customer → price → quote (charge + discount + GST) → book (idempotent)
 *   → fetch → flags → list filters → dashboard tiles → tenant isolation → input validation
 *
 * Needs a running API with test OTPs enabled (local only: TEST_BYPASS_OTP_PHONES=*, OTP 123456):
 *   node src/server.js &            # API on :4500
 *   node scripts/pos-smoke.mjs      # exits 1 on the first failed check, after printing every result
 *
 * Env: API (default http://localhost:4500/api/v1), OTP (default 123456). It creates two throw-away POS shops
 * with random phone numbers and never touches existing data.
 */
import { randomUUID } from 'node:crypto'

const API = process.env.API || 'http://localhost:4500/api/v1'
const OTP = process.env.OTP || '123456'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json, data: json?.data }
}

async function newPosShop(label) {
  const phone = `9${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 9000 + 1000)}`
  await call(null, 'POST', '/auth/send-otp', { phone })
  const login = await call(null, 'POST', '/auth/verify-otp', { phone, otp: OTP })
  if (!login.data?.accessToken) throw new Error(`Login failed for ${phone}: ${JSON.stringify(login.body)} (is TEST_BYPASS_OTP_PHONES set on the API?)`)
  let token = login.data.accessToken
  const started = await call(token, 'POST', '/vendor/pos-onboarding/start', {})
  const refreshed = await call(null, 'POST', '/auth/refresh-token', { refreshToken: login.data.refreshToken })
  token = refreshed.data.accessToken
  const steps = [
    ['shop', { name: `Smoke ${label}`, ownerName: 'Smoke Owner', addressLine1: '1 Test Road', city: 'Pune', pincode: '411001' }],
    ['tax', { gstEnabled: false }],
    ['counter', { printerProfile: 'none', orderSeriesPrefix: 'SM', defaultDeliveryDays: 2 }],
    ['pricelist', { choice: 'starter' }],
  ]
  for (const [step, data] of steps) await call(token, 'PATCH', '/vendor/pos-onboarding', { step, data })
  const done = await call(token, 'POST', '/vendor/pos-onboarding/complete', {})
  return { phone, token, started, done }
}

const today = new Date().toISOString().slice(0, 10)
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

const A = await newPosShop('A')
check('POS onboarding completes with the starter price list', A.started.status < 300 && A.done.status === 200 && A.done.data?.starterPricelist?.garments > 0, A.done.body)
const mode = await call(A.token, 'GET', '/vendor/app-mode')
check('app-mode: POS only, walletless STANDARD shop', mode.data?.appMode?.offering === 'POS' && mode.data.appMode.allowedModes.join() === 'POS' && mode.data.appMode.walletAccess === false, mode.body)

// ── customer, price ─────────────────────────────────────────────────────
const cust = await call(A.token, 'POST', '/vendor/counter/customers', { name: 'Smoke Customer', phone: '9000012345' })
check('create customer', cust.status === 201 && cust.data?.customer?.id, cust.body)
const again = await call(A.token, 'POST', '/vendor/counter/customers', { name: 'Smoke Customer', phone: '9000012345' })
check('creating the same phone again returns the same customer (still "new" to this shop: no history yet)', again.data?.customer?.id === cust.data.customer.id && again.data.created === true, again.body)
check('a bad phone is refused in plain words', (await call(A.token, 'POST', '/vendor/counter/customers', { name: 'X', phone: '123' })).status === 400)

const catalogue = (await call(A.token, 'GET', '/vendor/pos-catalogue')).data
const dry = catalogue.services.find((s) => s.name === 'Dry Cleaning')
const garment = await call(A.token, 'POST', '/vendor/pos-catalogue/garments', { name: 'Smoke Tee', unit: 'piece' })
const price = await call(A.token, 'POST', '/vendor/pos-catalogue/prices', { garmentId: garment.data?.garment?.id, serviceId: dry.id, ratePaise: 12000 })
check('add a garment and a ₹120 price', garment.status === 201 && price.status === 201 && price.data.price.ratePaise === 12000, { g: garment.body, p: price.body })
check('a second price for the same garment + service is refused (edit it instead)', (await call(A.token, 'POST', '/vendor/pos-catalogue/prices', { garmentId: garment.data.garment.id, serviceId: dry.id, ratePaise: 1 })).status === 409)
const upd = await call(A.token, 'PUT', `/vendor/pos-catalogue/prices/${price.data.price.id}`, { ratePaise: 12000 })
check('a price can be updated', upd.status === 200)

// ── quote: charge 10%, discount ₹5, GST 18% — expected total worked out here with integers ─────
const charge = await call(A.token, 'POST', '/vendor/adjustment-rules/charge', { name: 'Express', type: 'PERCENTAGE', percentageBps: 1000 })
const disc = await call(A.token, 'POST', '/vendor/adjustment-rules/discount', { name: 'Festival', type: 'FLAT', flatAmountPaise: 500 })
const items = [{ garmentId: garment.data.garment.id, serviceId: dry.id, qty: 3 }]
const body = {
  customer: { id: cust.data.customer.id }, expectedDeliveryDate: inDays(2), items, paymentMode: 'PAY_LATER',
  chargeRuleIds: [charge.data.id], discountRuleIds: [disc.data.id], taxRatePercent: 18, deliveryMode: 'HOME_DELIVERY', isExpress: true,
}
const subtotal = 3 * 12000
const chargePaise = Math.round((subtotal * 1000) / 10000)
const taxable = subtotal + chargePaise - 500
const tax = Math.round((taxable * 1800) / 10000)
const expectedTotal = taxable + tax
const quote = await call(A.token, 'POST', '/vendor/counter/orders/quote', body)
const q = quote.data?.quote
check(`quote total is ${expectedTotal} paise (3 × ₹120 + 10% − ₹5 + 18% GST)`, q?.totalPaise === expectedTotal && q.subtotalPaise === subtotal && q.chargesPaise === chargePaise && q.discountsPaise === 500 && q.taxPaise === tax, q)
check('quote without a customer still prices (a bill before choosing the customer)', (await call(A.token, 'POST', '/vendor/counter/orders/quote', { ...body, customer: undefined })).data?.quote?.totalPaise === expectedTotal)

// ── book, idempotently ──────────────────────────────────────────────────
const key = randomUUID()
const booked = await call(A.token, 'POST', '/vendor/counter/orders', body, { 'Idempotency-Key': key })
const order = booked.data?.order
check('book: BOOKED with the quoted total, unpaid, flags saved', booked.status === 201 && order?.status === 'BOOKED' && order.totalPaise === expectedTotal && order.paymentStatus === 'UNPAID' && order.deliveryMode === 'HOME_DELIVERY' && order.isExpress === true && /^LND-\d{6}-[A-Z0-9]{4}$/.test(order.orderNumber), booked.body)
const replay = await call(A.token, 'POST', '/vendor/counter/orders', body, { 'Idempotency-Key': key })
check('retrying with the same Idempotency-Key returns the SAME order (no double booking)', replay.data?.order?.id === order.id)
check('a malformed Idempotency-Key is refused', (await call(A.token, 'POST', '/vendor/counter/orders', body, { 'Idempotency-Key': 'nope' })).status === 400)
const cash = await call(A.token, 'POST', '/vendor/counter/orders', { ...body, chargeRuleIds: [], discountRuleIds: [], taxRatePercent: undefined, deliveryMode: undefined, isExpress: undefined, paymentMode: 'CASH' }, { 'Idempotency-Key': randomUUID() })
check('a CASH order is paid in full and defaults to walk-in / not express', cash.data?.order?.paymentStatus === 'PAID' && cash.data.order.totalPaise === subtotal && cash.data.order.deliveryMode === 'WALK_IN' && cash.data.order.isExpress === false, cash.body)

const afterHistory = await call(A.token, 'POST', '/vendor/counter/customers', { name: 'Other Name', phone: '9000012345' })
check('once the shop has an order for them, the same phone is a returning customer under their saved name', afterHistory.data?.customer?.id === cust.data.customer.id && afterHistory.data.created === false && afterHistory.data.customer.name === 'Smoke Customer', afterHistory.body)

// ── read back, filters, edit ────────────────────────────────────────────
const one = await call(A.token, 'GET', `/vendor/counter/orders/${order.id}`)
check('GET order returns the booked flags and total', one.data?.order?.deliveryMode === 'HOME_DELIVERY' && one.data.order.isExpress === true && one.data.order.totalPaise === expectedTotal)
const list = (await call(A.token, 'GET', '/vendor/counter/orders')).data
check('list has both orders', list.length === 2)
check('?deliveryMode=HOME_DELIVERY filters', (await call(A.token, 'GET', '/vendor/counter/orders?deliveryMode=HOME_DELIVERY')).data.map((o) => o.id).join() === order.id)
check('?express=true filters', (await call(A.token, 'GET', '/vendor/counter/orders?express=true')).data.map((o) => o.id).join() === order.id)
const patched = await call(A.token, 'PATCH', `/vendor/counter/orders/${cash.data.order.id}`, { deliveryMode: 'PICKUP', isExpress: true })
check('PATCH changes the flags (and nothing else)', patched.data?.order?.deliveryMode === 'PICKUP' && patched.data.order.isExpress === true && patched.data.order.totalPaise === subtotal)

// ── dashboard tiles must equal what we just did ─────────────────────────
const home = (await call(A.token, 'GET', '/vendor/pos/dashboard')).data?.home
check('dashboard: bookings 2, pending 2, express 2', home?.bookingsToday === 2 && home.pendingOrders === 2 && home.expressOrders === 2, home)
check(`dashboard: revenue ${expectedTotal + subtotal}, collected ${subtotal}, to collect ${expectedTotal}`, home.todayRevenuePaise === expectedTotal + subtotal && home.todayCollectionPaise === subtotal && home.collectionDuePaise === expectedTotal, home)
check('dashboard: 1 pickup waiting for a captain (the cash order was edited to PICKUP and is still BOOKED)', home.unassignedPickups === 1 && home.unassignedDeliveries === 0, home)

// ── another shop sees none of it ────────────────────────────────────────
const B = await newPosShop('B')
const bHome = (await call(B.token, 'GET', '/vendor/pos/dashboard')).data.home
check('shop B has an empty dashboard', Object.values(bHome).every((v) => v === 0), bHome)
check('shop B cannot read shop A\'s order', (await call(B.token, 'GET', `/vendor/counter/orders/${order.id}`)).status === 404)
check('shop B\'s order list is empty', (await call(B.token, 'GET', '/vendor/counter/orders')).data.length === 0)
check('shop B cannot book with shop A\'s garment', (await call(B.token, 'POST', '/vendor/counter/orders', { ...body, customer: { name: 'Z', phone: '9000099999' } }, { 'Idempotency-Key': randomUUID() })).status === 400)

// ── bad input is a 4xx with words, never a 500 ──────────────────────────
for (const [name, patch] of [
  ['unknown deliveryMode', { deliveryMode: 'TELEPORT' }],
  ['isExpress as text', { isExpress: 'yes' }],
  ['no delivery date', { expectedDeliveryDate: undefined }],
  ['empty cart', { items: [] }],
  ['malformed customer id', { customer: { id: 'not-a-uuid' } }],
]) {
  const r = await call(A.token, 'POST', '/vendor/counter/orders', { ...body, ...patch }, { 'Idempotency-Key': randomUUID() })
  check(`refused with 400: ${name}`, r.status === 400 && typeof r.body?.message === 'string' && !r.body.stack, r.body)
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
