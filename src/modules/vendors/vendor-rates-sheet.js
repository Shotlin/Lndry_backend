import ExcelJS from 'exceljs'
import { getClient, query } from '../../config/database.js'

// Excel export/import of a vendor's whole services + rates catalogue.
//
// Template layout (two sheets, both keyed by hidden-from-editing ID columns):
//   "Services": one row per vendor service  -> base price, min weight, active
//   "Rates"   : one row per service x garment (subcategory) -> rate, available
//
// Every garment type in the service's category is listed, even when the vendor
// has not priced it yet (blank rate), so the sheet doubles as a price-entry form.
// Import is all-or-nothing: any invalid row aborts the whole file and nothing
// is written, so a half-applied price list can never go live.

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_ROWS = 5000

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }
const LOCKED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
const INPUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } }

function styleHeader(ws, editableCols) {
  const row = ws.getRow(1)
  row.height = 22
  row.eachCell((cell, col) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = editableCols.includes(col) ? { ...HEADER_FILL, fgColor: { argb: 'FF16A34A' } } : HEADER_FILL
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

function shade(ws, rowNumber, colCount, editableCols) {
  for (let c = 1; c <= colCount; c++) {
    ws.getRow(rowNumber).getCell(c).fill = editableCols.includes(c) ? INPUT_FILL : LOCKED_FILL
  }
}

export async function buildRatesTemplate(vendorId) {
  const { rows: vendorRows } = await query('SELECT name FROM vendors WHERE id = $1', [vendorId])
  const vendorName = vendorRows[0]?.name || 'Vendor'

  const { rows: services } = await query(
    `SELECT vs.id, vs.name, vs.category_id, sc.name AS category_name, vs.is_available,
            COALESCE(vs.price, 0) AS price, COALESCE(vs.min_weight_kg, 1.0) AS min_weight_kg
     FROM vendor_services vs
     LEFT JOIN service_categories sc ON sc.id = vs.category_id
     WHERE vs.vendor_id = $1 AND vs.deleted_at IS NULL
     ORDER BY sc.name NULLS LAST, vs.name`,
    [vendorId]
  )

  const { rows: rates } = services.length
    ? await query(
        `SELECT vs.id AS service_id, gt.id AS garment_id, gt.name AS garment_name, gt.unit,
                vsr.rate_paise, vsr.is_active
         FROM vendor_services vs
         JOIN garment_types gt ON gt.category_id = vs.category_id AND gt.is_active = true
         LEFT JOIN vendor_service_rates vsr
                ON vsr.vendor_service_id = vs.id AND vsr.garment_type_id = gt.id
         WHERE vs.vendor_id = $1 AND vs.deleted_at IS NULL
         UNION
         SELECT vsr.vendor_service_id, gt.id, gt.name, gt.unit, vsr.rate_paise, vsr.is_active
         FROM vendor_service_rates vsr
         JOIN vendor_services vs ON vs.id = vsr.vendor_service_id
         JOIN garment_types gt ON gt.id = vsr.garment_type_id AND gt.is_active = true
         WHERE vs.vendor_id = $1 AND vs.deleted_at IS NULL
         ORDER BY garment_name`,
        [vendorId]
      )
    : { rows: [] }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'LNDRY Admin'
  wb.created = new Date()

  // ── Instructions ──
  const help = wb.addWorksheet('Instructions')
  help.columns = [{ width: 110 }]
  ;[
    `Services & Rates template — ${vendorName}`,
    '',
    '1. Edit ONLY the yellow cells (green headers). Grey cells are identifiers — do not change them.',
    '2. "Rates" sheet: enter the price in rupees (e.g. 49.50) per item. Leave the rate blank to skip an item that is not offered.',
    '3. "Available" accepts Yes or No. Blank keeps the current setting (new rates default to Yes).',
    '4. "Services" sheet: update base price, minimum weight (kg) and Active (Yes/No) per service.',
    '5. Do not add, delete or reorder columns, and do not edit the Service ID / Item ID columns.',
    '6. Save as .xlsx, then use "Import rates" on the vendor\'s Services & Rates tab.',
    '7. The import is all-or-nothing: if any row has an error, nothing is saved and every error is listed with its row number.',
  ].forEach((line, i) => {
    const cell = help.getCell(i + 1, 1)
    cell.value = line
    if (i === 0) cell.font = { bold: true, size: 14 }
    cell.alignment = { wrapText: true, vertical: 'top' }
  })

  // ── Services ──
  const sSheet = wb.addWorksheet('Services')
  sSheet.columns = [
    { header: 'Service ID', key: 'id', width: 38 },
    { header: 'Category', key: 'category', width: 26 },
    { header: 'Service', key: 'name', width: 32 },
    { header: 'Base Price (₹)', key: 'price', width: 16 },
    { header: 'Min Weight (kg)', key: 'min', width: 16 },
    { header: 'Active (Yes/No)', key: 'active', width: 16 },
  ]
  styleHeader(sSheet, [4, 5, 6])
  services.forEach((s, i) => {
    sSheet.addRow({
      id: s.id,
      category: s.category_name || '',
      name: s.name,
      price: Number(s.price),
      min: Number(s.min_weight_kg),
      active: s.is_available ? 'Yes' : 'No',
    })
    shade(sSheet, i + 2, 6, [4, 5, 6])
    sSheet.getCell(i + 2, 4).numFmt = '0.00'
  })
  sSheet.dataValidations.add(`F2:F${Math.max(services.length + 1, 2)}`, {
    type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
  })

  // ── Rates ──
  const rSheet = wb.addWorksheet('Rates')
  rSheet.columns = [
    { header: 'Service ID', key: 'service_id', width: 38 },
    { header: 'Item ID', key: 'garment_id', width: 38 },
    { header: 'Category', key: 'category', width: 26 },
    { header: 'Service', key: 'service', width: 30 },
    { header: 'Item / Subcategory', key: 'item', width: 30 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Rate (₹)', key: 'rate', width: 14 },
    { header: 'Available (Yes/No)', key: 'available', width: 18 },
  ]
  styleHeader(rSheet, [7, 8])
  let r = 2
  for (const s of services) {
    for (const g of rates.filter(x => x.service_id === s.id)) {
      rSheet.addRow({
        service_id: s.id,
        garment_id: g.garment_id,
        category: s.category_name || '',
        service: s.name,
        item: g.garment_name,
        unit: g.unit || 'piece',
        rate: g.rate_paise == null ? null : g.rate_paise / 100,
        available: g.rate_paise == null ? '' : (g.is_active ? 'Yes' : 'No'),
      })
      shade(rSheet, r, 8, [7, 8])
      rSheet.getCell(r, 7).numFmt = '0.00'
      r++
    }
  }
  rSheet.dataValidations.add(`H2:H${Math.max(r - 1, 2)}`, {
    type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
  })
  rSheet.dataValidations.add(`G2:G${Math.max(r - 1, 2)}`, {
    type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0],
    showErrorMessage: true, errorTitle: 'Invalid rate', error: 'Enter a rupee amount of 0 or more.',
  })
  rSheet.autoFilter = { from: 'A1', to: 'H1' }

  const buffer = await wb.xlsx.writeBuffer()
  const safeName = vendorName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'vendor'
  return { buffer, contentType: XLSX_TYPE, filename: `${safeName}-services-rates-template.xlsx` }
}

// ── helpers for import ──
function cellText(v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text).trim()
    if (v.result != null) return String(v.result).trim()
    if (v.richText) return v.richText.map(t => t.text).join('').trim()
  }
  return String(v).trim()
}

function parseYesNo(raw) {
  const t = cellText(raw).toLowerCase()
  if (t === '') return { value: undefined }
  if (['yes', 'y', 'true', '1', 'active'].includes(t)) return { value: true }
  if (['no', 'n', 'false', '0', 'inactive', 'hidden'].includes(t)) return { value: false }
  return { error: 'must be Yes or No' }
}

function parseMoneyOrNumber(raw) {
  const t = cellText(raw).replace(/[₹,\s]/g, '')
  if (t === '') return { value: undefined }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return { error: 'must be a number of 0 or more' }
  return { value: n }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function importRatesSheet(vendorId, buffer, adminUserId) {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer)
  } catch {
    throw { statusCode: 400, message: 'Could not read the file. Please upload the .xlsx template downloaded from this page.' }
  }
  const sSheet = wb.getWorksheet('Services')
  const rSheet = wb.getWorksheet('Rates')
  if (!sSheet && !rSheet) {
    throw { statusCode: 400, message: 'This is not the services & rates template — the "Services" / "Rates" sheets are missing.' }
  }
  if ((sSheet?.rowCount || 0) > MAX_ROWS || (rSheet?.rowCount || 0) > MAX_ROWS) {
    throw { statusCode: 400, message: `Too many rows (max ${MAX_ROWS}).` }
  }

  const { rows: services } = await query(
    `SELECT id, name, category_id, is_available,
            COALESCE((price * 100)::int, 0) AS price_paise, COALESCE(min_weight_kg, 1.0)::float AS min_weight_kg
     FROM vendor_services WHERE vendor_id = $1 AND deleted_at IS NULL`,
    [vendorId]
  )
  const svcMap = new Map(services.map(s => [s.id, s]))
  const { rows: existingRates } = await query(
    `SELECT vsr.vendor_service_id, vsr.garment_type_id, vsr.rate_paise, vsr.is_active
     FROM vendor_service_rates vsr JOIN vendor_services vs ON vs.id = vsr.vendor_service_id
     WHERE vs.vendor_id = $1 AND vs.deleted_at IS NULL`,
    [vendorId]
  )
  const rateMap = new Map(existingRates.map(r => [`${r.vendor_service_id}|${r.garment_type_id}`, r]))
  const { rows: garments } = await query(
    `SELECT id, category_id FROM garment_types WHERE is_active = true`
  )
  const garmentCat = new Map(garments.map(g => [g.id, g.category_id]))

  const errors = []
  const err = (sheet, row, message) => errors.push({ sheet, row, message })
  const serviceUpdates = []
  const rateUpserts = []
  let unchanged = 0

  if (sSheet) {
    const seen = new Set()
    sSheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return
      const id = cellText(row.getCell(1).value)
          if (!id) return
      if (!UUID_RE.test(id) || !svcMap.has(id)) return err('Services', n, 'Service ID not found for this vendor — do not edit the ID column')
      if (seen.has(id)) return err('Services', n, 'Duplicate Service ID')
      seen.add(id)
      const cur = svcMap.get(id)
      const price = parseMoneyOrNumber(row.getCell(4).value)
      const min = parseMoneyOrNumber(row.getCell(5).value)
      const active = parseYesNo(row.getCell(6).value)
      if (price.error) err('Services', n, `Base Price ${price.error}`)
      if (min.error) err('Services', n, `Min Weight ${min.error}`)
      if (active.error) err('Services', n, `Active ${active.error}`)
      if (price.error || min.error || active.error) return
      const patch = {}
      if (price.value !== undefined && Math.round(price.value * 100) !== cur.price_paise) patch.price_paise = Math.round(price.value * 100)
      if (min.value !== undefined && Math.abs(min.value - cur.min_weight_kg) > 1e-9) patch.min_weight_kg = min.value
      if (active.value !== undefined && active.value !== cur.is_available) patch.is_available = active.value
      if (Object.keys(patch).length) serviceUpdates.push({ id, patch })
      else unchanged++
    })
  }

  if (rSheet) {
    const seen = new Set()
    rSheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return
      const sid = cellText(row.getCell(1).value)
      const gid = cellText(row.getCell(2).value)
      if (!sid && !gid) return
      const svc = svcMap.get(sid)
      if (!UUID_RE.test(sid) || !svc) return err('Rates', n, 'Service ID not found for this vendor — do not edit the ID columns')
      if (!UUID_RE.test(gid) || !garmentCat.has(gid)) return err('Rates', n, 'Item ID not found — do not edit the ID columns')
      if (garmentCat.get(gid) !== svc.category_id && !rateMap.has(`${sid}|${gid}`)) {
        return err('Rates', n, 'Item does not belong to this service\'s category')
      }
      const key = `${sid}|${gid}`
      if (seen.has(key)) return err('Rates', n, 'Duplicate row for the same service and item')
      seen.add(key)
      const rate = parseMoneyOrNumber(row.getCell(7).value)
      const avail = parseYesNo(row.getCell(8).value)
      if (rate.error) err('Rates', n, `Rate ${rate.error}`)
      if (avail.error) err('Rates', n, `Available ${avail.error}`)
      if (rate.error || avail.error) return
      const cur = rateMap.get(key)
      if (rate.value === undefined && !cur) { unchanged++; return } // blank new item = not offered
      const ratePaise = rate.value === undefined ? cur.rate_paise : Math.round(rate.value * 100)
      const isActive = avail.value === undefined ? (cur ? cur.is_active : true) : avail.value
      if (cur && cur.rate_paise === ratePaise && cur.is_active === isActive) { unchanged++; return }
      rateUpserts.push({ sid, gid, ratePaise, isActive, isNew: !cur })
    })
  }

  if (errors.length) {
    throw { statusCode: 422, message: `${errors.length} problem${errors.length === 1 ? '' : 's'} found — nothing was saved.`, errors: errors.slice(0, 200) }
  }

  const client = await getClient()
  try {
    await client.query('BEGIN')
    for (const { id, patch } of serviceUpdates) {
      const sets = []
      const params = []
      let i = 1
      if (patch.price_paise !== undefined) { sets.push(`price = $${i++}`); params.push(patch.price_paise / 100) }
      if (patch.min_weight_kg !== undefined) { sets.push(`min_weight_kg = $${i++}`); params.push(patch.min_weight_kg) }
      if (patch.is_available !== undefined) { sets.push(`is_available = $${i++}`); params.push(patch.is_available) }
      // Same as any other admin edit: applies immediately and stays approved.
      if (patch.price_paise !== undefined || patch.min_weight_kg !== undefined) {
        sets.push(`approval_status = 'APPROVED'`, `approved_at = NOW()`, `approved_by = $${i++}`, `rejection_reason = NULL`)
        params.push(adminUserId)
      }
      sets.push('updated_at = NOW()')
      params.push(id, vendorId)
      await client.query(
        `UPDATE vendor_services SET ${sets.join(', ')} WHERE id = $${i++} AND vendor_id = $${i} AND deleted_at IS NULL`,
        params
      )
    }
    if (rateUpserts.length) {
      await client.query(
        `INSERT INTO vendor_service_rates (vendor_service_id, garment_type_id, rate_paise, is_active)
         SELECT s, g, r, a FROM UNNEST($1::uuid[], $2::uuid[], $3::int[], $4::bool[]) AS t(s, g, r, a)
         ON CONFLICT (vendor_service_id, garment_type_id)
         DO UPDATE SET rate_paise = EXCLUDED.rate_paise, is_active = EXCLUDED.is_active,
                       override_reason = NULL, override_at = NULL, updated_at = NOW()`,
        [rateUpserts.map(x => x.sid), rateUpserts.map(x => x.gid), rateUpserts.map(x => x.ratePaise), rateUpserts.map(x => x.isActive)]
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  return {
    services_updated: serviceUpdates.length,
    rates_updated: rateUpserts.filter(x => !x.isNew).length,
    rates_added: rateUpserts.filter(x => x.isNew).length,
    unchanged,
  }
}
