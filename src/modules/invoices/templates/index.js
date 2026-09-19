import demoV1 from './demo-v1.js'

/**
 * Invoice template registry.
 *
 * A template is a pure presentation module:
 *
 *   { id: 'string', render(invoiceData) => Promise<Buffer> (a PDF) }
 *
 * `invoiceData` is the frozen snapshot produced by invoice-data.builder.js
 * (all money in integer paise, already reconciled — see that file). A template
 * only lays it out. It must not query the database, calculate totals, or know
 * anything about the mobile app.
 *
 * To ship the final design:
 *   1. add `pro-v1.js` next to demo-v1.js exporting the shape above,
 *   2. register it below,
 *   3. point DEFAULT_TEMPLATE_ID at it (or set INVOICE_TEMPLATE=pro-v1 in the
 *      server's app.env — no code change or app release needed either way).
 * Every invoice issued afterwards uses it; already-issued invoices keep the
 * PDF they were issued with until an admin re-renders them
 * (POST /api/v1/admin/invoices/regenerate).
 */
const TEMPLATES = {
  [demoV1.id]: demoV1,
}

export const DEFAULT_TEMPLATE_ID = 'demo-v1'

export function getActiveTemplate() {
  const wanted = process.env.INVOICE_TEMPLATE || DEFAULT_TEMPLATE_ID
  return TEMPLATES[wanted] || TEMPLATES[DEFAULT_TEMPLATE_ID]
}

export const listTemplateIds = () => Object.keys(TEMPLATES)
