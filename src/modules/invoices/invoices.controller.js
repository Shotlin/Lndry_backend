import { success, error } from '../../utils/apiResponse.js'
import { InvoiceError } from './invoices.service.js'

const baseUrlOf = (request) =>
  (process.env.PUBLIC_API_URL || `${request.protocol}://${request.hostname}`).replace(/\/$/, '')

/** RFC 6266 header value with a plain-ASCII fallback name. */
const contentDisposition = (disposition, fileName) =>
  `${disposition}; filename="${fileName.replace(/[^\w.\-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`

export class InvoicesController {
  constructor(service) {
    this.service = service
  }

  _fail(reply, err) {
    if (err instanceof InvoiceError) {
      return reply.code(err.statusCode).send(error(err.message, err.code))
    }
    throw err
  }

  _sendPdf(reply, file, disposition) {
    return reply
      .header('Content-Type', file.contentType)
      .header('Content-Disposition', contentDisposition(disposition, file.fileName))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.buffer)
  }

  /** GET /invoices/orders/:orderId — invoice info; issues it first if it doesn't exist yet. */
  async getForOrder(request, reply) {
    try {
      const { invoice } = await this.service.getOrIssueForCustomer(request.user.id, request.params.orderId)
      return reply.code(200).send(success(this.service.present(invoice, { baseUrl: baseUrlOf(request) }), 'Invoice fetched'))
    } catch (err) {
      return this._fail(reply, err)
    }
  }

  /** POST /invoices/orders/:orderId/generate — explicit, idempotent issue. */
  async generateForOrder(request, reply) {
    try {
      const { invoice, created } = await this.service.getOrIssueForCustomer(request.user.id, request.params.orderId)
      return reply
        .code(created ? 201 : 200)
        .send(success(this.service.present(invoice, { baseUrl: baseUrlOf(request) }), created ? 'Invoice generated' : 'Invoice already generated'))
    } catch (err) {
      return this._fail(reply, err)
    }
  }

  /** GET /invoices/orders/:orderId/pdf — the PDF itself (Bearer-authenticated). */
  async pdfForOrder(request, reply) {
    try {
      const file = await this.service.getPdfForCustomer(request.user.id, request.params.orderId)
      return this._sendPdf(reply, file, request.query.download ? 'attachment' : 'inline')
    } catch (err) {
      return this._fail(reply, err)
    }
  }

  /** GET /invoices/download?t=<token> — the PDF via a short-lived signed link (no header needed). */
  async downloadByLink(request, reply) {
    try {
      const file = await this.service.getPdfForLink(request.query.t)
      return this._sendPdf(reply, file, file.disposition)
    } catch (err) {
      return this._fail(reply, err)
    }
  }

  /** POST /admin/invoices/regenerate */
  async regenerate(request, reply) {
    try {
      const actor = {
        userId: request.user?.id ?? null,
        role: request.user?.platform_role ?? request.user?.role ?? null,
        ip: request.ip ?? null,
        userAgent: request.headers?.['user-agent'] ?? null,
      }
      const result = await this.service.regenerate(request.body || {}, actor)
      return reply.code(200).send(success(result, 'Invoices re-rendered with the active template'))
    } catch (err) {
      return this._fail(reply, err)
    }
  }
}
