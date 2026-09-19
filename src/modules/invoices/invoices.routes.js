import { InvoicesController } from './invoices.controller.js'
import { InvoicesService } from './invoices.service.js'
import {
  getInvoiceSchema,
  generateInvoiceSchema,
  invoicePdfSchema,
  downloadInvoiceSchema,
  regenerateInvoicesSchema,
} from './invoices.schema.js'

const build = () => new InvoicesController(new InvoicesService())

/**
 * Customer routes — mounted at /api/v1/invoices.
 *
 * The app's whole invoice feature is: GET the info for an order, then open
 * the `viewUrl` / `downloadUrl` it is given. It never builds or prices an
 * invoice, so template changes need no app release.
 */
export default async function invoicesRoutes(fastify) {
  const controller = build()
  const auth = [fastify.authenticate]

  fastify.get('/orders/:orderId', {
    schema: getInvoiceSchema,
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, controller.getForOrder.bind(controller))

  fastify.post('/orders/:orderId/generate', {
    schema: generateInvoiceSchema,
    preHandler: auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, controller.generateForOrder.bind(controller))

  fastify.get('/orders/:orderId/pdf', {
    schema: invoicePdfSchema,
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, controller.pdfForOrder.bind(controller))

  // The token itself is the credential (10-minute, single-invoice, signed). It
  // travels in the query string, not the path: a JWT is ~200 chars and
  // Fastify's default maxParamLength (100) would 404 it.
  fastify.get('/download', {
    schema: downloadInvoiceSchema,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, controller.downloadByLink.bind(controller))
}

/**
 * Admin routes — mounted at /api/v1/admin/invoices.
 */
export async function adminInvoicesRoutes(fastify) {
  const controller = build()

  fastify.post('/regenerate', {
    schema: regenerateInvoicesSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.regenerate.bind(controller))
}
