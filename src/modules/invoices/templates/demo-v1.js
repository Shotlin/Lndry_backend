import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'

/**
 * TEMPORARY demo invoice template ("demo-v1").
 *
 * Purpose: prove the end-to-end flow (backend issues -> app opens) while the
 * final design is being worked on. It is intentionally plain. Replace it by
 * adding a new template module and registering it in ./index.js — nothing
 * else changes. See index.js for the contract.
 */

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts')
const BRAND = '#6D5FE8'
const INK = '#1F2430'
const MUTED = '#6B7280'
const LINE = '#E3E5EC'
const TINT = '#F4F3FE'

const PAGE_MARGIN = 40
const CONTENT_W = 595.28 - PAGE_MARGIN * 2 // A4

const rupees = (paise) =>
  `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dateOnly = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    : '—'

const METHOD_LABELS = {
  COD: 'Cash on delivery',
  CASH: 'Cash',
  ONLINE: 'Online',
  UPI: 'UPI',
  CARD: 'Card',
  BANK: 'Bank transfer',
  WALLET: 'LNDRY Wallet',
  LNDRY_WALLET: 'LNDRY Wallet',
}
const methodLabel = (m) => (m ? METHOD_LABELS[String(m).toUpperCase()] || String(m) : '—')

const STATUS_LABELS = { PAID: 'Paid', PARTIALLY_PAID: 'Partially paid', UNPAID: 'Unpaid' }

function drawKeyValueBlock(doc, { x, y, width, title, name, lines }) {
  doc.font('Bold').fontSize(8).fillColor(MUTED).text(title.toUpperCase(), x, y, { width, characterSpacing: 0.6 })
  let cursor = y + 14
  doc.font('Bold').fontSize(11).fillColor(INK).text(name || '—', x, cursor, { width })
  cursor = doc.y + 2
  doc.font('Regular').fontSize(9).fillColor(MUTED)
  for (const line of lines.filter(Boolean)) {
    doc.text(line, x, cursor, { width })
    cursor = doc.y
  }
  return cursor
}

export default {
  id: 'demo-v1',

  /** @param {object} data invoice snapshot — see invoice-data.builder.js */
  render(data) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: PAGE_MARGIN,
        bufferPages: true,
        info: {
          Title: `Invoice ${data.invoice.number}`,
          Author: 'LNDRY',
          Subject: `Invoice for order ${data.order.number || data.order.id}`,
        },
      })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      try {
        doc.registerFont('Regular', path.join(FONT_DIR, 'Roboto-Regular.ttf'))
        doc.registerFont('Bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'))
        drawInvoice(doc, data)
        drawFooters(doc, data)
        doc.end()
      } catch (err) {
        reject(err)
      }
    })
  },
}

function drawInvoice(doc, data) {
  const { invoice, order, company, customer, vendor, lines, totals, payment } = data
  const left = PAGE_MARGIN
  const right = PAGE_MARGIN + CONTENT_W
  const isTaxInvoice = totals.taxPaise > 0

  // ── Header ────────────────────────────────────────────────────────────────
  doc.roundedRect(left, 40, 34, 34, 8).fill(BRAND)
  doc.font('Bold').fontSize(22).fillColor('#FFFFFF').text('L', left, 47, { width: 34, align: 'center' })
  doc.font('Bold').fontSize(24).fillColor(BRAND).text('LNDRY', left + 44, 41)
  doc.font('Regular').fontSize(8.5).fillColor(MUTED).text(company.tagline || '', left + 44, 68, { width: 260 })

  doc.font('Bold').fontSize(20).fillColor(INK).text(isTaxInvoice ? 'TAX INVOICE' : 'INVOICE', left, 40, {
    width: CONTENT_W,
    align: 'right',
  })
  doc.font('Regular').fontSize(9).fillColor(MUTED)
  const metaRows = [
    ['Invoice no.', invoice.number],
    ['Invoice date', dateOnly(invoice.invoiceDate)],
    ['Order no.', order.number || order.id.slice(0, 8).toUpperCase()],
  ]
  let metaY = 68
  for (const [k, v] of metaRows) {
    doc.font('Regular').fillColor(MUTED).text(k, right - 230, metaY, { width: 90, align: 'right' })
    doc.font('Bold').fillColor(INK).text(v, right - 132, metaY, { width: 132, align: 'right' })
    metaY += 13
  }

  let y = Math.max(metaY, 96) + 8
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(LINE).stroke()
  y += 14

  // ── Parties ───────────────────────────────────────────────────────────────
  const colW = (CONTENT_W - 24) / 2
  const customerBottom = drawKeyValueBlock(doc, {
    x: left,
    y,
    width: colW,
    title: 'Billed to',
    name: customer.name,
    lines: [customer.phone, ...(customer.address?.lines || [])],
  })
  const vendorBottom = drawKeyValueBlock(doc, {
    x: left + colW + 24,
    y,
    width: colW,
    title: 'Service provided by',
    name: vendor?.name || '—',
    lines: vendor
      ? [...(vendor.address?.lines || []), vendor.phone && `Phone: ${vendor.phone}`, vendor.gstin && `GSTIN: ${vendor.gstin}`]
      : [],
  })
  y = Math.max(customerBottom, vendorBottom) + 14

  // ── Order facts strip ─────────────────────────────────────────────────────
  const stripH = 50
  doc.roundedRect(left, y, CONTENT_W, stripH, 6).fill(TINT)
  // The order id is a full UUID, so its cell gets the widest share.
  const facts = [
    ['Order ID', order.id, 196, 8],
    ['Order date', dateOnly(order.placedAt), 84, 9],
    ['Delivered on', dateOnly(order.deliveredAt), 84, 9],
    ['Payment', `${STATUS_LABELS[payment.status] || payment.status} · ${methodLabel(payment.method)}`, 151, 8.5],
  ]
  let fx = left + 12
  facts.forEach(([k, v, w, size]) => {
    doc.font('Regular').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), fx, y + 9, { width: w - 10 })
    doc.font('Bold').fontSize(size).fillColor(INK).text(v, fx, y + 22, { width: w - 10 })
    fx += w
  })
  y += stripH + 18

  // ── Items ─────────────────────────────────────────────────────────────────
  const cols = { n: left, desc: left + 24, qty: left + 262, rate: left + 362, amt: left + 432 }
  const widths = { n: 20, desc: 232, qty: 96, rate: 66, amt: right - (left + 432) }

  const drawTableHead = (top) => {
    doc.rect(left, top, CONTENT_W, 22).fill(BRAND)
    doc.font('Bold').fontSize(8.5).fillColor('#FFFFFF')
    doc.text('#', cols.n + 6, top + 7, { width: widths.n })
    doc.text('SERVICE / ITEM', cols.desc, top + 7, { width: widths.desc })
    doc.text('QTY / WEIGHT', cols.qty, top + 7, { width: widths.qty })
    doc.text('RATE', cols.rate, top + 7, { width: widths.rate, align: 'right' })
    doc.text('AMOUNT', cols.amt, top + 7, { width: widths.amt - 8, align: 'right' })
    return top + 22
  }

  const pageBottom = doc.page.height - 110
  y = drawTableHead(y)
  lines.forEach((line, idx) => {
    doc.font('Regular').fontSize(9.5)
    const rowH = Math.max(doc.heightOfString(line.description, { width: widths.desc }), 12) + 12
    if (y + rowH > pageBottom) {
      doc.addPage()
      y = drawTableHead(PAGE_MARGIN)
    }
    if (idx % 2 === 1) doc.rect(left, y, CONTENT_W, rowH).fill('#FAFAFC')
    doc.fillColor(MUTED).text(String(idx + 1), cols.n + 6, y + 6, { width: widths.n })
    doc.fillColor(INK).text(line.description, cols.desc, y + 6, { width: widths.desc })
    doc.fillColor(INK).text(line.quantityLabel, cols.qty, y + 6, { width: widths.qty })
    doc.fillColor(INK).text(rupees(line.ratePaise), cols.rate, y + 6, { width: widths.rate, align: 'right' })
    doc.font('Bold').fillColor(INK).text(rupees(line.amountPaise), cols.amt, y + 6, { width: widths.amt - 8, align: 'right' })
    y += rowH
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke()
  })
  y += 16

  // ── Totals (right) + Payment summary (left) ───────────────────────────────
  const totalRows = [['Subtotal', totals.subtotalPaise, false]]
  if (totals.deliveryFeePaise) totalRows.push(['Delivery fee', totals.deliveryFeePaise, false])
  // A counter order carries its own labelled lines ("Additional Charge (5%)", "Discount (10%)"); an
  // app order has the fixed fee rows.
  if (totals.chargeLines?.length) totals.chargeLines.forEach((line) => totalRows.push([line.label, line.amountPaise, false]))
  else if (totals.platformFeePaise) totalRows.push(['Platform / service fee', totals.platformFeePaise, false])
  if (totals.expressFeePaise) totalRows.push(['Express pickup fee', totals.expressFeePaise, false])
  if (totals.discountLines?.length) totals.discountLines.forEach((line) => totalRows.push([line.label, -line.amountPaise, false]))
  else if (totals.discountPaise) {
    totalRows.push([`Discount${totals.couponCode ? ` (${totals.couponCode})` : ''}`, -totals.discountPaise, false])
  }
  if (totals.taxPaise) {
    const rate = totals.taxRatePercent ? ` (${totals.taxRatePercent}%)` : ''
    totalRows.push([`${totals.taxLabel || 'GST'}${rate}`, totals.taxPaise, false])
  }
  if (totals.adjustmentPaise) totalRows.push(['Adjustment', totals.adjustmentPaise, false])

  const boxW = 230
  const boxX = right - boxW
  const paymentRows = [
    ['Advance payment', payment.advancePaise],
    ['Final payment', payment.finalPaise],
    ['Total paid', payment.paidPaise],
    ['Balance due', payment.balanceDuePaise],
  ]
  const needed = Math.max(totalRows.length * 18 + 44, paymentRows.length * 18 + 62)
  if (y + needed > doc.page.height - 100) {
    doc.addPage()
    y = PAGE_MARGIN
  }
  const blockTop = y

  // payment summary
  doc.font('Bold').fontSize(8).fillColor(MUTED).text('PAYMENT SUMMARY', left, blockTop, { characterSpacing: 0.6 })
  let py = blockTop + 16
  paymentRows.forEach(([label, paise]) => {
    doc.font('Regular').fontSize(9.5).fillColor(INK).text(label, left, py, { width: 130 })
    doc.font('Bold').text(rupees(paise), left + 120, py, { width: 90, align: 'right' })
    py += 18
  })
  doc.font('Regular').fontSize(9).fillColor(MUTED)
  const listed = payment.payments.map(
    (p) =>
      `${p.purpose === 'BALANCE' ? 'Final' : p.purpose === 'ADVANCE' ? 'Advance' : 'Paid'}: ${methodLabel(p.method)} · ${rupees(p.amountPaise)} · ${dateOnly(p.paidAt)}`
  )
  listed.forEach((t) => {
    doc.text(t, left, py, { width: 260 })
    py = doc.y + 1
  })

  // totals
  let ty = blockTop
  totalRows.forEach(([label, paise]) => {
    doc.font('Regular').fontSize(9.5).fillColor(INK).text(label, boxX, ty, { width: 130 })
    doc.text(paise < 0 ? `− ${rupees(-paise)}` : rupees(paise), boxX + 110, ty, { width: boxW - 110, align: 'right' })
    ty += 18
  })
  doc.moveTo(boxX, ty + 2).lineTo(right, ty + 2).lineWidth(1).strokeColor(LINE).stroke()
  ty += 8
  doc.roundedRect(boxX, ty, boxW, 32, 6).fill(BRAND)
  doc.font('Bold').fontSize(10.5).fillColor('#FFFFFF').text('GRAND TOTAL', boxX + 12, ty + 10, { width: 110 })
  doc.fontSize(13).text(rupees(totals.totalPaise), boxX + 100, ty + 8, { width: boxW - 112, align: 'right' })
  ty += 32

  // status pill
  const statusText = (STATUS_LABELS[payment.status] || payment.status).toUpperCase()
  const pillColor = payment.status === 'PAID' ? '#1E9E6A' : '#D97706'
  doc.font('Bold').fontSize(9)
  const pillW = doc.widthOfString(statusText) + 22
  doc.roundedRect(right - pillW, ty + 10, pillW, 20, 10).fill(pillColor)
  doc.fillColor('#FFFFFF').text(statusText, right - pillW, ty + 16, { width: pillW, align: 'center' })

  doc.y = Math.max(py, ty + 34)
}

function drawFooters(doc, data) {
  const range = doc.bufferedPageRange()
  const { company, invoice } = data
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    // The footer sits inside the bottom margin. PDFKit starts a new page for
    // any text below page.maxY(), so drop the bottom margin while drawing it.
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0

    const y = doc.page.height - 62
    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_W, y).lineWidth(0.5).strokeColor(LINE).stroke()
    doc.font('Bold').fontSize(9).fillColor(INK).text('Thank you for choosing LNDRY!', PAGE_MARGIN, y + 8, { width: CONTENT_W, align: 'center', lineBreak: false })
    const contact = [company.supportPhone && `Support: ${company.supportPhone}`, company.supportEmail].filter(Boolean).join('  ·  ')
    doc.font('Regular').fontSize(8).fillColor(MUTED)
    if (contact) doc.text(contact, PAGE_MARGIN, y + 21, { width: CONTENT_W, align: 'center', lineBreak: false })
    doc.text(
      `This is a computer-generated invoice and does not require a signature.  ·  ${invoice.number}  ·  Page ${i + 1} of ${range.count}`,
      PAGE_MARGIN,
      y + 32,
      { width: CONTENT_W, align: 'center', lineBreak: false }
    )
    doc.fontSize(6.5).fillColor('#A0A4B0').text('Temporary demo template (demo-v1)', PAGE_MARGIN, y + 44, { width: CONTENT_W, align: 'center', lineBreak: false })

    doc.page.margins.bottom = savedBottom
  }
}
