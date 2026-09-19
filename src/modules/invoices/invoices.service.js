import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { InvoicesRepository } from './invoices.repository.js'
import {
  buildInvoiceData,
  resolveOrderRef,
  isInvoiceable,
  financialYearLabel,
} from './invoice-data.builder.js'
import { getActiveTemplate } from './templates/index.js'

const LINK_TTL_SECONDS = 10 * 60
const LINK_PURPOSE = 'invoice_pdf'

/** A business-rule refusal the controller turns into an HTTP error. */
class InvoiceError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

const notFound = () => new InvoiceError('ORDER_NOT_FOUND', 'Order not found', 404)
const notReady = () =>
  new InvoiceError('INVOICE_NOT_AVAILABLE', 'The invoice is available once your order has been delivered.', 409)

/**
 * Invoices service.
 *
 * Backend-owned end to end: the numbers come from the invoice-data builder,
 * the look comes from the active template module, and this class only
 * orchestrates them and guarantees "one invoice per order, issued once".
 */
export class InvoicesService {
  constructor(repository = new InvoicesRepository()) {
    this.repo = repository
  }

  // ── Customer-facing ────────────────────────────────────────────────────────

  /** Loads the order and checks it belongs to [userId] (a foreign id reads as "not found"). */
  async _ownedOrder(userId, orderId) {
    const ref = await resolveOrderRef(orderId)
    if (!ref || ref.customerId !== userId) throw notFound()
    return ref
  }

  /**
   * The invoice for one of the customer's own orders, issued now if it hasn't
   * been yet (existing delivered orders get theirs on first request).
   */
  async getOrIssueForCustomer(userId, orderId) {
    const ref = await this._ownedOrder(userId, orderId)
    return this.ensureInvoice(ref)
  }

  async getPdfForCustomer(userId, orderId) {
    const { invoice } = await this.getOrIssueForCustomer(userId, orderId)
    return this.loadPdf(invoice)
  }

  /** The same backend-issued invoice, for the admin dashboard's "Download invoice". */
  async getPdfForAdmin(orderId) {
    const ref = await resolveOrderRef(orderId)
    if (!ref) throw notFound()
    const { invoice } = await this.ensureInvoice(ref)
    return this.loadPdf(invoice)
  }

  // ── Core: idempotent issue ─────────────────────────────────────────────────

  /**
   * Returns the order's invoice, issuing it first if needed. Safe to call any
   * number of times, concurrently: the invoice number is allocated once and
   * the stored PDF is reused thereafter.
   */
  async ensureInvoice(ref) {
    const existing = await this.repo.findByOrder(ref.type, ref.id)
    if (existing) return { invoice: existing, created: false }

    if (!isInvoiceable(ref)) throw notReady()

    const data = await buildInvoiceData(ref)
    if (!data) throw notFound()
    const template = getActiveTemplate()

    const { invoice, created } = await this.repo.issueOnce({
      orderType: ref.type,
      orderId: ref.id,
      customerId: ref.customerId,
      vendorId: ref.vendorId,
      orderNumber: data.order.number,
      numberFor: (n) => `INV-${financialYearLabel(data.invoice.invoiceDate)}-${String(n).padStart(6, '0')}`,
      prepare: async (number) => {
        const snapshot = { ...data, invoice: { ...data.invoice, number } }
        const pdf = await template.render(snapshot)
        return { snapshot, pdf, templateId: template.id, sha256: sha256(pdf) }
      },
    })

    if (created) {
      logger.info({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, orderId: ref.id, template: template.id }, 'Invoice issued')
      emitAudit('invoice_issued', {
        actor_user_id: null,
        actor_role: 'SYSTEM',
        target_type: 'invoice',
        target_id: invoice.id,
        before: null,
        after: { invoiceNumber: invoice.invoiceNumber, orderId: ref.id, orderType: ref.type, totalPaise: invoice.totalPaise },
      })
    }
    return { invoice, created }
  }

  /**
   * Issues the invoice for an order that was just delivered, without a
   * customer request (the `generate-invoice` background job). A no-op if the
   * order isn't delivered (e.g. the delivering transaction rolled back).
   */
  async issueIfDelivered(orderId) {
    const ref = await resolveOrderRef(orderId)
    if (!ref || !isInvoiceable(ref)) return { skipped: true }
    return this.ensureInvoice(ref)
  }

  async loadPdf(invoice) {
    let file = await this.repo.findPdf(invoice.id)
    if (!file) {
      // Row without a stored file (shouldn't happen) — heal it from the snapshot.
      await this.rerender(invoice)
      file = await this.repo.findPdf(invoice.id)
    }
    return {
      buffer: file.buffer,
      contentType: file.contentType,
      fileName: `LNDRY-Invoice-${invoice.invoiceNumber}.pdf`,
      invoice,
    }
  }

  // ── Signed, short-lived links (so the app can simply open a URL) ───────────

  signLink(invoice, disposition) {
    const token = jwt.sign(
      { purpose: LINK_PURPOSE, inv: invoice.id, disp: disposition },
      env.JWT_ACCESS_SECRET,
      { expiresIn: LINK_TTL_SECONDS }
    )
    return { token, expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString() }
  }

  /** Verifies a link token and returns the PDF it grants access to. */
  async getPdfForLink(token) {
    let claims
    try {
      claims = jwt.verify(token, env.JWT_ACCESS_SECRET)
    } catch {
      throw new InvoiceError('LINK_EXPIRED', 'This invoice link has expired. Please open the invoice again from the app.', 401)
    }
    if (claims.purpose !== LINK_PURPOSE || !claims.inv) {
      throw new InvoiceError('LINK_INVALID', 'Invalid invoice link', 401)
    }
    const invoice = await this.repo.findById(claims.inv)
    if (!invoice) throw notFound()
    const file = await this.loadPdf(invoice)
    return { ...file, disposition: claims.disp === 'attachment' ? 'attachment' : 'inline' }
  }

  // ── Admin: re-render with the current template ─────────────────────────────

  /**
   * Re-renders stored invoices with the template that is active now — for
   * previewing a new design on real data. The invoice number and id never
   * change. `rebuild: true` also re-reads the order/payment data (use only if
   * the snapshot's data is known to be wrong); by default the frozen snapshot
   * is reused so the money on the invoice cannot move.
   */
  async regenerate({ orderId, rebuild = false, limit = 100 }, actor) {
    let refs
    if (orderId) {
      const ref = await resolveOrderRef(orderId)
      if (!ref) throw notFound()
      refs = [{ orderType: ref.type, orderId: ref.id }]
    } else {
      refs = await this.repo.listOrderRefs({ limit })
    }

    const results = { regenerated: 0, skipped: 0, failed: [] }
    for (const r of refs) {
      try {
        const invoice = await this.repo.findByOrder(r.orderType, r.orderId)
        if (!invoice) {
          results.skipped++
          continue
        }
        await this.rerender(invoice, { rebuild })
        results.regenerated++
      } catch (err) {
        logger.error({ err: err.message, orderId: r.orderId }, 'Invoice regeneration failed')
        results.failed.push({ orderId: r.orderId, error: err.message })
      }
    }
    emitAudit('invoice_regenerated', {
      actor_user_id: actor?.userId ?? null,
      actor_role: actor?.role ?? null,
      target_type: 'invoice',
      target_id: null,
      before: null,
      after: { orderId: orderId ?? null, rebuild, ...results },
      ip_address: actor?.ip ?? null,
      user_agent: actor?.userAgent ?? null,
    })
    return { ...results, template: getActiveTemplate().id }
  }

  async rerender(invoice, { rebuild = false } = {}) {
    const template = getActiveTemplate()
    let snapshot = await this.repo.findSnapshot(invoice.id)
    let rebuilt = null
    if (rebuild) {
      const ref = await resolveOrderRef(invoice.orderId)
      const data = ref && (await buildInvoiceData(ref))
      if (data) {
        rebuilt = { ...data, invoice: { ...data.invoice, number: invoice.invoiceNumber } }
        snapshot = rebuilt
      }
    }
    const pdf = await template.render(snapshot)
    await this.repo.replaceRendition(invoice.id, {
      pdf,
      sha256: sha256(pdf),
      templateId: template.id,
      snapshot: rebuilt,
    })
  }

  // ── Presentation ───────────────────────────────────────────────────────────

  /**
   * The JSON the app gets. Everything on it comes from the stored invoice;
   * the app displays it and opens the two links — it derives nothing.
   */
  present(invoice, { baseUrl }) {
    const view = this.signLink(invoice, 'inline')
    const download = this.signLink(invoice, 'attachment')
    const url = (token) => `${baseUrl}/api/v1/invoices/download?t=${token}`
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      orderId: invoice.orderId,
      orderNumber: invoice.orderNumber,
      orderType: invoice.orderType,
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      invoiceDate: invoice.invoiceDate,
      currency: invoice.currency,
      subtotalPaise: invoice.subtotalPaise,
      discountPaise: invoice.discountPaise,
      deliveryFeePaise: invoice.deliveryFeePaise,
      platformFeePaise: invoice.platformFeePaise,
      taxPaise: invoice.taxPaise,
      totalPaise: invoice.totalPaise,
      amountPaidPaise: invoice.amountPaidPaise,
      balanceDuePaise: invoice.balanceDuePaise,
      paymentStatus: invoice.paymentStatus,
      paymentMethod: invoice.paymentMethod,
      templateId: invoice.templateId,
      pdf: {
        contentType: 'application/pdf',
        sizeBytes: invoice.pdfSizeBytes,
        generatedAt: invoice.pdfGeneratedAt,
      },
      viewUrl: url(view.token),
      downloadUrl: url(download.token),
      linksExpireAt: view.expiresAt,
    }
  }
}

export { InvoiceError }

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
