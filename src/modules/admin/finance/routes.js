import { AdminFinanceController } from './controller.js'
import { AdminFinanceService } from './service.js'
import { AdminFinanceRepository } from './repository.js'

/**
 * Admin Finance routes — HQ-scoped finance endpoints (task 8.9).
 * Prefix: /api/v1/admin/finance
 *
 * All routes require:
 *   - Valid JWT (fastify.authenticate)
 *   - finance.global_view permission (ADMIN role)
 *   - mark-paid additionally requires shop_financials.mark_paid
 */
export default async function adminFinanceRoutes(fastify) {
  const repository = new AdminFinanceRepository()
  const service = new AdminFinanceService(repository)
  const controller = new AdminFinanceController(service)

  // Permission guard: finance.global_view (ADMIN / HQ_FINANCE)
  const requireGlobalView = async function (request, reply) {
    const role = request.user?.role
    if (role === 'ADMIN') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — finance.global_view permission required',
      code: 'FORBIDDEN',
    })
  }

  // Permission guard: shop_financials.mark_paid (ADMIN only)
  const requireMarkPaid = async function (request, reply) {
    const role = request.user?.role
    if (role === 'ADMIN') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — shop_financials.mark_paid permission required',
      code: 'FORBIDDEN',
    })
  }

  const readPreHandlers = [fastify.authenticate, requireGlobalView]
  const markPaidPreHandlers = [fastify.authenticate, requireMarkPaid]

  // GET /vendors — list vendors with finance overview
  fastify.get('/vendors', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'List vendors [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listShops.bind(controller))

  // GET /vendors/:shopId/transactions — shop transactions (HQ view)
  fastify.get('/vendors/:shopId/transactions', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop transactions [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listShopTransactions.bind(controller))

  // GET /vendors/:shopId/financials — shop financials (HQ view)
  fastify.get('/vendors/:shopId/financials', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop financials [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listShopFinancials.bind(controller))

  // POST /vendors/:shopId/payouts/:periodId/mark-paid
  fastify.post('/vendors/:shopId/payouts/:periodId/mark-paid', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Mark payout as paid [shop_financials.mark_paid]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: markPaidPreHandlers,
  }, controller.markPaid.bind(controller))

  // GET /payout-report — CSV export (max 10000 rows)
  fastify.get('/payout-report', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Payout report CSV [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.payoutReport.bind(controller))

  // GET /comparison — shop comparison view
  fastify.get('/comparison', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop comparison [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.comparison.bind(controller))
}
