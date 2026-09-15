import { AdminFinanceController } from './controller.js'
import { AdminFinanceService } from './service.js'
import { AdminFinanceRepository } from './repository.js'
import { requirePermission } from '../../../middlewares/permission-check.js'

/**
 * Admin Finance routes — HQ-scoped finance endpoints (task 8.9).
 * Prefix: /api/v1/admin/finance
 *
 * All routes require:
 *   - Valid JWT (fastify.authenticate)
 *   - finance.global_view permission (ADMIN role)
 *   - legacy mark-paid route is retained only as a fail-closed compatibility
 *     response until a provider-evidenced payout workflow is connected.
 */
export default async function adminFinanceRoutes(fastify) {
  const repository = new AdminFinanceRepository()
  const service = new AdminFinanceService(repository)
  const controller = new AdminFinanceController(service)

  // Canonical permission enforcement is deliberately separate from the
  // legacy role check. This allows a real HQ_FINANCE identity to read the
  // finance surface while keeping vendor/shop identities out of global data.
  const readPreHandlers = [fastify.authenticate, requirePermission('finance.global_view')]
  const markPaidPreHandlers = [fastify.authenticate, requirePermission('shop_financials.mark_paid')]

  // GET /vendors — list vendors with finance overview
  fastify.get('/vendors', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'List vendors [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    config: { requiredPermission: 'finance.global_view' },
    preHandler: readPreHandlers,
  }, controller.listShops.bind(controller))

  // GET /vendors/:shopId/transactions — shop transactions (HQ view)
  fastify.get('/vendors/:shopId/transactions', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop transactions [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    config: { requiredPermission: 'finance.global_view' },
    preHandler: readPreHandlers,
  }, controller.listShopTransactions.bind(controller))

  // GET /vendors/:shopId/financials — shop financials (HQ view)
  fastify.get('/vendors/:shopId/financials', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop financials [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    config: { requiredPermission: 'finance.global_view' },
    preHandler: readPreHandlers,
  }, controller.listShopFinancials.bind(controller))

  // POST /vendors/:shopId/payouts/:periodId/mark-paid
  fastify.post('/vendors/:shopId/payouts/:periodId/mark-paid', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Mark payout as paid [shop_financials.mark_paid]',
      security: [{ bearerAuth: [] }],
    },
    config: { requiredPermission: 'shop_financials.mark_paid' },
    preHandler: markPaidPreHandlers,
  }, controller.markPaid.bind(controller))

  // GET /payout-report — CSV export (max 10000 rows)
  fastify.get('/payout-report', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Payout report CSV [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    config: { requiredPermission: 'finance.global_view' },
    preHandler: readPreHandlers,
  }, controller.payoutReport.bind(controller))

  // GET /comparison — shop comparison view
  fastify.get('/comparison', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop comparison [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    config: { requiredPermission: 'finance.global_view' },
    preHandler: readPreHandlers,
  }, controller.comparison.bind(controller))
}
