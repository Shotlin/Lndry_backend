// Real Socket.IO server (the real socketio.plugin.js) + real socket.io-client
// sockets. Only Postgres/Redis are faked. Proves the events the Vendor/Rider
// apps ring an alarm for actually reach the right person (and only them).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify from 'fastify'
import { io as connect } from 'socket.io-client'
import { Adapter } from 'socket.io-adapter'

vi.mock('../../../src/config/redis.js', () => ({
  redis: { duplicate: () => ({ disconnect() {} }), del: vi.fn(), get: vi.fn() },
}))
vi.mock('@socket.io/redis-adapter', () => ({ createAdapter: () => Adapter }))
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(async (sql) =>
    String(sql).includes('vendor_employees')
      ? { rows: [{ vendor_id: 'shop-D' }] }
      : { rows: [{ order_number: 'LNDR-TEST-001' }] }),
  getClient: vi.fn(),
}))

const { env } = await import('../../../src/config/env.js')
const socketioPlugin = (await import('../../../src/plugins/socketio.plugin.js')).default
const { emitJobOfferedToRiders } = await import('../../../src/plugins/socketio.plugin.js')
const { VendorOrdersService } = await import('../../../src/modules/vendor-orders/vendor-orders.service.js')

const sign = (p) => jwt.sign(p, env.JWT_ACCESS_SECRET, { expiresIn: '5m' })
let app, url
const sockets = []

async function login(payload) {
  const s = connect(url, { auth: { token: sign(payload) }, transports: ['websocket'], forceNew: true })
  sockets.push(s)
  await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej) })
  return s
}
const nextEvent = (s, ev, ms = 1500) =>
  new Promise((res) => {
    const t = setTimeout(() => res(null), ms)
    s.once(ev, (d) => { clearTimeout(t); res(d) })
  })

beforeAll(async () => {
  app = Fastify()
  await app.register(socketioPlugin)
  await app.listen({ port: 0, host: '127.0.0.1' })
  url = `http://127.0.0.1:${app.server.address().port}`
})
afterAll(async () => {
  sockets.forEach((s) => s.close())
  await app.close()
})

describe('vendor new-order alert (order.created -> shop room)', () => {
  it('reaches the owning shop only, with bill amount', async () => {
    const shopA = await login({ id: 'u-owner-a', role: 'ADMIN', shopId: 'shop-A', shopRole: 'VENDOR_OWNER' })
    const shopB = await login({ id: 'u-owner-b', role: 'ADMIN', shopId: 'shop-B', shopRole: 'VENDOR_OWNER' })
    const gotA = nextEvent(shopA, 'order.created')
    const gotB = nextEvent(shopB, 'order.created', 600)
    app.io.to('shop:shop-A').emit('order.created', {
      order_id: 'o1', order_number: 'LNDR-1', total_amount: 499, status: 'WAITING_VENDOR_CONFIRMATION',
    })
    expect(await gotA).toMatchObject({ order_number: 'LNDR-1', total_amount: 499 })
    expect(await gotB).toBeNull()
  })
})

describe('paid-online order (VENDOR_NEW_ORDER lifecycle) rings the shop', () => {
  it('emits order.created to the shop room even though checkout code was not used', async () => {
    const { LifecycleNotificationService } = await import('../../../src/modules/lifecycle-notifications/lifecycle-notifications.service.js')
    const shop = await login({ id: 'u-owner-c', role: 'ADMIN', shopId: 'shop-C', shopRole: 'VENDOR_OWNER' })
    const svc = Object.create(LifecycleNotificationService.prototype)
    svc._context = async () => ({ id: 'o-paid', order_number: 'LNDR-PAID', vendor_id: 'shop-C', status: 'WAITING_VENDOR_CONFIRMATION', total_amount: '799.00' })
    svc._template = async () => ({ recipient: 'VENDOR' })
    svc._recipients = async () => []
    svc._captainName = async () => null
    const got = nextEvent(shop, 'order.created')
    await svc.emit('VENDOR_NEW_ORDER', { orderId: 'o-paid' })
    expect(await got).toMatchObject({ order_id: 'o-paid', order_number: 'LNDR-PAID', total_amount: 799 })
  })
})

describe('token without shopId', () => {
  it('still joins the shop room (resolved from DB) and hears new orders', async () => {
    const owner = await login({ id: 'u-owner-d', role: 'VENDOR' })
    await new Promise((r) => setTimeout(r, 200))
    const got = nextEvent(owner, 'order.created')
    app.io.to('shop:shop-D').emit('order.created', { order_id: 'o-d', order_number: 'LNDR-D' })
    expect(await got).toMatchObject({ order_number: 'LNDR-D' })
  })
})

describe('rider alerts', () => {
  it('job:offered (broadcast) reaches only the targeted riders', async () => {
    const r1 = await login({ id: 'rider-1', role: 'ADMIN', shopId: 'shop-A', shopRole: 'VENDOR_RIDER' })
    const r2 = await login({ id: 'rider-2', role: 'ADMIN', shopId: 'shop-A', shopRole: 'VENDOR_RIDER' })
    const g1 = nextEvent(r1, 'job:offered')
    const g2 = nextEvent(r2, 'job:offered', 600)
    emitJobOfferedToRiders(['rider-1'], { orderId: 'o1', orderNumber: 'LNDR-1', purpose: 'PICKUP' })
    expect(await g1).toMatchObject({ orderId: 'o1', purpose: 'PICKUP' })
    expect(await g2).toBeNull()
  })

  it('direct assign -> job:assigned reaches that rider', async () => {
    const r = await login({ id: 'rider-3', role: 'ADMIN', shopId: 'shop-A', shopRole: 'VENDOR_RIDER' })
    const svc = Object.create(VendorOrdersService.prototype)
    const got = nextEvent(r, 'job:assigned')
    await svc._notifyRiderAssigned('rider-3', 'o9', 'DELIVERY')
    expect(await got).toMatchObject({ orderId: 'o9', orderNumber: 'LNDR-TEST-001', purpose: 'DELIVERY' })
  })

  it('targeted offer -> job:offered reaches that rider', async () => {
    const r = await login({ id: 'rider-4', role: 'ADMIN', shopId: 'shop-A', shopRole: 'VENDOR_RIDER' })
    const svc = Object.create(VendorOrdersService.prototype)
    const got = nextEvent(r, 'job:offered')
    await svc._notifyRiderAssigned('rider-4', 'o10', 'PICKUP', { offer: true })
    expect(await got).toMatchObject({ orderId: 'o10', purpose: 'PICKUP' })
  })

  it('order:assigned (admin/auto-assign path) reaches the rider', async () => {
    const r = await login({ id: 'rider-5', role: 'ADMIN', shopId: 'shop-A', shopRole: 'VENDOR_RIDER' })
    const got = nextEvent(r, 'order:assigned')
    app.emitOrderAssignedToRider('rider-5', { orderId: 'o11', orderNumber: 'LNDR-11' })
    expect(await got).toMatchObject({ orderId: 'o11' })
  })
})
