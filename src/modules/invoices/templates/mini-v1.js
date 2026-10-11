import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'

/**
 * Mini bill ("mini-v1"): a narrow counter receipt for 58 mm or 80 mm thermal paper.
 *
 * Like every template it only lays out the invoice data the builder produced (all money in integer
 * paise); it never works out a total. The page is exactly as tall as the bill — it is drawn once to
 * measure and once for real — so a thermal printer or a share sheet gets one clean strip.
 */

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts')
const MM = 72 / 25.4
export const MINI_PAPER_MM = [58, 80]

const rupees = (paise) =>
  `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : ''
const METHOD_LABELS = { CASH: 'Cash', UPI: 'Online', CARD: 'Card', BANK: 'Bank', WALLET: 'Wallet', ONLINE: 'Online' }
const methodLabel = (m) => (m ? METHOD_LABELS[String(m).toUpperCase()] || String(m) : '')

function draw(doc, data, paperMm) {
  const margin = paperMm === 58 ? 6 : 9
  const width = paperMm * MM - margin * 2
  const body = paperMm === 58 ? 7.5 : 8.5
  const x = margin
  const rule = () => {
    doc.moveDown(0.3)
    doc.moveTo(x, doc.y).lineTo(x + width, doc.y).dash(1.5, { space: 1.5 }).strokeColor('#000000').lineWidth(0.5).stroke().undash()
    doc.moveDown(0.4)
  }
  const row = (left, right, { bold = false, size = body } = {}) => {
    const y = doc.y
    doc.font(bold ? 'Bold' : 'Regular').fontSize(size)
    const rightW = doc.widthOfString(right) + 2
    doc.text(left, x, y, { width: width - rightW - 4 })
    const bottom = doc.y
    doc.text(right, x + width - rightW, y, { width: rightW, align: 'right', lineBreak: false })
    doc.y = bottom
  }
  const center = (text, size, bold = false) => doc.font(bold ? 'Bold' : 'Regular').fontSize(size).text(text, x, doc.y, { width, align: 'center' })

  doc.y = margin
  const shop = data.vendor?.name || data.company?.name || 'LNDRY'
  center(shop, body + 4, true)
  for (const line of data.vendor?.address?.lines || []) center(line, body - 1)
  if (data.vendor?.phone) center(`Ph: ${data.vendor.phone}`, body - 1)
  if (data.vendor?.gstin) center(`GSTIN: ${data.vendor.gstin}`, body - 1)
  rule()
  center(data.invoice?.number ? `INVOICE ${data.invoice.number}` : 'BILL', body + 1, true)
  rule()
  row('Order', data.order.number || String(data.order.id).slice(0, 8).toUpperCase(), { bold: true })
  row('Date', dateTime(data.order.placedAt))
  if (data.customer?.name) row('Customer', data.customer.name)
  if (data.customer?.phone) row('Phone', data.customer.phone)
  rule()
  for (const line of data.lines) {
    doc.font('Regular').fontSize(body).text(line.description, x, doc.y, { width })
    row(`  ${line.quantityLabel} × ${rupees(line.ratePaise)}`, rupees(line.amountPaise))
  }
  rule()
  const t = data.totals
  row('Items', rupees(t.subtotalPaise))
  for (const c of t.chargeLines?.length ? t.chargeLines : t.platformFeePaise > 0 ? [{ label: 'Charges', amountPaise: t.platformFeePaise }] : []) row(c.label, rupees(c.amountPaise))
  for (const d of t.discountLines?.length ? t.discountLines : t.discountPaise > 0 ? [{ label: 'Discount', amountPaise: t.discountPaise }] : []) row(d.label, `-${rupees(d.amountPaise)}`)
  if (t.taxPaise > 0) row(t.taxRatePercent ? `${t.taxLabel || 'GST'} (${t.taxRatePercent}%)` : t.taxLabel || 'GST', rupees(t.taxPaise))
  if (t.adjustmentPaise) row('Round off', `${t.adjustmentPaise < 0 ? '-' : ''}${rupees(Math.abs(t.adjustmentPaise))}`)
  rule()
  row('TOTAL', rupees(t.totalPaise), { bold: true, size: body + 2 })
  for (const p of data.payment?.payments || []) row(`Paid (${methodLabel(p.method)})`, rupees(p.amountPaise))
  row('Balance due', rupees(data.payment?.balanceDuePaise), { bold: true })
  rule()
  center('Thank you! Visit again', body)
  doc.moveDown(0.5)
  return doc.y + margin
}

/** Draws the bill on a page of the given height; resolves { buffer, endY }. */
function renderOnPage(data, paperMm, height) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [paperMm * MM, height], margin: 0, info: { Title: `Bill ${data.order.number || ''}`, Author: 'LNDRY' } })
    const chunks = []
    let endY = 0
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), endY }))
    doc.on('error', reject)
    try {
      doc.registerFont('Regular', path.join(FONT_DIR, 'Roboto-Regular.ttf'))
      doc.registerFont('Bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'))
      endY = draw(doc, data, paperMm)
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

export default {
  id: 'mini-v1',

  /** @param {object} data invoice snapshot  @param {58|80} paperMm  @returns {Promise<Buffer>} a one-page PDF */
  async render(data, paperMm = 80) {
    const paper = MINI_PAPER_MM.includes(Number(paperMm)) ? Number(paperMm) : 80
    // Pass 1 on a very tall page just to learn how tall the bill is; pass 2 draws it on a page of that height.
    const { endY } = await renderOnPage(data, paper, 20000)
    return (await renderOnPage(data, paper, Math.ceil(endY))).buffer
  },
}
