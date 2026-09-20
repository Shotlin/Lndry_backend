import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'
import { VendorCounterOrdersService } from './vendor-counter-orders.service.js'
import { VendorCounterViewsService } from './vendor-counter-views.service.js'
import { VendorPosCatalogueService } from '../vendor-pos-catalogue/vendor-pos-catalogue.service.js'

// No body schemas on purpose: this app's AJV runs with removeAdditional:'all', which would strip every
// field of a free-form body. Inputs are validated in the service instead.
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

/**
 * Counter (walk-in / drop-off) work orders — mounted at /api/v1/vendor/counter.
 * Customers, pricing, booking with garment/bag tags, lifecycle, payments and
 * the cross-order tag views the counter screens read.
 */
export default async function vendorCounterOrdersRoutes(fastify) {
  const service = new VendorCounterOrdersService()
  const views = new VendorCounterViewsService()
  const posCatalogue = new VendorPosCatalogueService()

  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to counter orders', code: 'FORBIDDEN' })
    }
  })
  fastify.addHook('preHandler', async (request, reply) => {
    const { rows } = await query(`SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true LIMIT 1`, [request.user.id])
    if (!rows.length) return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    request.vendorId = rows[0].vendor_id
  })

  const actorOf = (request) => ({
    userId: request.user?.id ?? null, role: request.user?.role ?? null, vendorId: request.vendorId,
    ip: request.ip ?? null, userAgent: request.headers?.['user-agent'] ?? null,
  })
  const reply = (res, result, okMessage, okStatus = 200) => {
    if (!result.success) return res.code(result.status || 400).send(error(result.message, result.code || 'VALIDATION_ERROR'))
    const { success: _s, ...data } = result
    return res.code(okStatus).send(success(data, okMessage))
  }
  const notFound = (res, what) => res.code(404).send(error(`${what} not found`, 'NOT_FOUND'))

  // The vendor's current type and what it allows (customer-app sync, LNDRY wallet). The POS
  // reads this at login/session load and whenever the window regains focus.
  fastify.get('/access', async (request, res) => {
    res.header('Cache-Control', 'no-store')
    return res.send(success(await service.access(request.vendorId)))
  })

  // Customers
  fastify.get('/customers', async (request, res) => res.send(success(await service.listCustomers(request.vendorId, request.query.search))))
  fastify.post('/customers', async (request, res) => reply(res, await service.findOrCreateCustomer(request.vendorId, actorOf(request), request.body || {}), 'Customer ready', 201))
  fastify.get('/customers/:id', { schema: { params: idParams } }, async (request, res) => {
    const profile = await service.customerProfile(request.vendorId, request.params.id)
    return profile ? res.send(success(profile)) : notFound(res, 'Customer')
  })

  // Orders
  fastify.post('/orders/quote', async (request, res) => reply(res, await service.quote(request.vendorId, request.body || {}), 'Quote computed'))
  fastify.post('/orders', async (request, res) => reply(res, await service.book(request.vendorId, actorOf(request), request.body || {}), 'Order booked', 201))
  fastify.get('/orders', async (request, res) => res.send(success(await service.listOrders(request.vendorId, request.query))))
  fastify.get('/orders/:id', { schema: { params: idParams } }, async (request, res) => {
    const detail = await service.getDetail(request.vendorId, request.params.id)
    return detail ? res.send(success(detail)) : notFound(res, 'Order')
  })
  fastify.patch('/orders/:id', { schema: { params: idParams} }, async (request, res) => reply(res, await service.update(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Order updated'))
  fastify.post('/orders/:id/transition', { schema: { params: idParams} }, async (request, res) => reply(res, await service.transition(request.vendorId, actorOf(request), request.params.id, request.body?.state, request.body || {}), 'Order updated'))
  fastify.post('/orders/:id/cancel', { schema: { params: idParams} }, async (request, res) => reply(res, await service.cancel(request.vendorId, actorOf(request), request.params.id, request.body?.reason), 'Order cancelled'))
  fastify.post('/orders/:id/assign', { schema: { params: idParams} }, async (request, res) => reply(res, await service.assign(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Captain assigned'))
  fastify.get('/orders/:id/payments', { schema: { params: idParams } }, async (request, res) => res.send(success(await service.listPayments(request.vendorId, request.params.id))))
  fastify.post('/orders/:id/payments', { schema: { params: idParams} }, async (request, res) => reply(res, await service.collectPayment(request.vendorId, actorOf(request), request.params.id, request.body || {}), 'Payment recorded', 201))

  // (POS garment, POS service) -> LNDRY rate id, for features that reference a marketplace price line (service packages)
  fastify.get('/rates', async (request, res) => res.send(success(await posCatalogue.listMarketplaceLinkedRates(request.vendorId))))

  // Cross-order tag views
  fastify.get('/garment-units', async (request, res) => res.send(success(await service.listGarmentUnits(request.vendorId, request.query))))
  fastify.get('/containers', async (request, res) => res.send(success(await service.listContainers(request.vendorId, request.query))))

  fastify.get('/garment-units/:id', { schema: { params: idParams } }, async (request, res) => {
    const unit = await views.unitView(request.vendorId, request.params.id)
    return unit ? res.send(success(unit)) : notFound(res, 'Garment')
  })
  fastify.get('/containers/:id', { schema: { params: idParams } }, async (request, res) => {
    const container = await views.containerView(request.vendorId, request.params.id)
    return container ? res.send(success(container)) : notFound(res, 'Bag')
  })

  // Work-queue, claims, returns and print history, joined for display
  fastify.get('/production-tasks', async (request, res) => res.send(success(await views.productionTasks(request.vendorId, request.query))))
  fastify.get('/quality-claims', async (request, res) => res.send(success(await views.qualityClaims(request.vendorId))))
  fastify.get('/quality-analytics', async (request, res) => res.send(success(await views.qualityAnalytics(request.vendorId))))
  fastify.get('/corrections', async (request, res) => res.send(success(await views.corrections(request.vendorId))))
  fastify.get('/returns', async (request, res) => res.send(success(await views.returns(request.vendorId))))
  fastify.get('/print-jobs', async (request, res) => res.send(success(await views.printJobs(request.vendorId, request.query))))
}
