import { query } from '../../config/database.js'
import { VendorCustomerLedgerController } from './vendor-customer-ledger.controller.js'
import { VendorCustomerLedgerService } from './vendor-customer-ledger.service.js'
import { VendorCustomerLedgerRepository } from './vendor-customer-ledger.repository.js'
import { appendLedgerEntrySchema, getLedgerStatementSchema } from './vendor-customer-ledger.schema.js'

/**
 * Vendor-facing customer ledger routes — mounted at
 * /api/v1/vendor/customer-ledger.
 */
export default async function vendorCustomerLedgerRoutes(fastify) {
  const service = new VendorCustomerLedgerService(new VendorCustomerLedgerRepository())
  const controller = new VendorCustomerLedgerController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to the customer ledger', code: 'FORBIDDEN' })
    }
  })

  fastify.addHook('preHandler', async (request, reply) => {
    const { rows } = await query(
      `SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [request.user.id]
    )
    if (!rows.length) {
      return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    }
    request.vendorId = rows[0].vendor_id
  })

  fastify.post('/', { schema: appendLedgerEntrySchema }, controller.append.bind(controller))
  fastify.get('/statement', { schema: getLedgerStatementSchema }, controller.getStatement.bind(controller))
}
