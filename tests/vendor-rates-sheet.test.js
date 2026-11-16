import { describe, it, expect, vi, beforeEach } from 'vitest'
import ExcelJS from 'exceljs'

const SVC = '11111111-1111-4111-8111-111111111111'
const CAT = '22222222-2222-4222-8222-222222222222'
const G1 = '33333333-3333-4333-8333-333333333333'
const G2 = '44444444-4444-4444-8444-444444444444'
const calls = []

vi.mock('../src/config/database.js', () => {
  const q = async (sql, params) => {
    calls.push({ sql, params })
    if (/FROM vendors WHERE id/.test(sql)) return { rows: [{ name: 'Test Vendor' }] }
    if (/FROM vendor_services vs\s+LEFT JOIN service_categories/.test(sql))
      return { rows: [{ id: SVC, name: 'Laundry', category_id: CAT, category_name: 'Laundry Services', is_available: true, price: '0', min_weight_kg: '1' }] }
    if (/JOIN garment_types gt ON gt.category_id/.test(sql))
      return { rows: [
        { service_id: SVC, garment_id: G1, garment_name: 'Shirt', unit: 'piece', rate_paise: 3000, is_active: true },
        { service_id: SVC, garment_id: G2, garment_name: 'Trouser', unit: 'piece', rate_paise: null, is_active: null },
      ] }
    if (/FROM vendor_services WHERE vendor_id/.test(sql))
      return { rows: [{ id: SVC, name: 'Laundry', category_id: CAT, is_available: true, price_paise: 0, min_weight_kg: 1 }] }
    if (/FROM vendor_service_rates vsr JOIN/.test(sql))
      return { rows: [{ vendor_service_id: SVC, garment_type_id: G1, rate_paise: 3000, is_active: true }] }
    if (/FROM garment_types WHERE is_active/.test(sql))
      return { rows: [{ id: G1, category_id: CAT }, { id: G2, category_id: CAT }] }
    return { rows: [] }
  }
  return { query: q, getClient: async () => ({ query: q, release() {} }) }
})

const { buildRatesTemplate, importRatesSheet } = await import('../src/modules/vendors/vendor-rates-sheet.js')

async function edited(mutate) {
  const { buffer } = await buildRatesTemplate('v1')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  mutate(wb)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('vendor rates sheet', () => {
  beforeEach(() => { calls.length = 0 })

  it('template lists every item incl. unpriced ones', async () => {
    const { buffer, filename } = await buildRatesTemplate('v1')
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer)
    const rates = wb.getWorksheet('Rates')
    expect(rates.rowCount).toBe(3)
    expect(rates.getCell(2, 7).value).toBe(30)
    expect(rates.getCell(3, 7).value).toBeNull()
    expect(filename).toBe('test-vendor-services-rates-template.xlsx')
  })

  it('imports edited prices and new rates', async () => {
    const buf = await edited(wb => {
      const r = wb.getWorksheet('Rates')
      r.getCell(2, 7).value = 45.5
      r.getCell(3, 7).value = 60
      wb.getWorksheet('Services').getCell(2, 4).value = 10
    })
    const res = await importRatesSheet('v1', buf, 'admin1')
    expect(res).toEqual({ services_updated: 1, rates_updated: 1, rates_added: 1, unchanged: 0 })
    const upsert = calls.find(c => /INSERT INTO vendor_service_rates/.test(c.sql))
    expect(upsert.params[2]).toEqual([4550, 6000])
  })

  it('rejects whole file on bad rows and writes nothing', async () => {
    const buf = await edited(wb => {
      const r = wb.getWorksheet('Rates')
      r.getCell(2, 7).value = 'abc'
      r.getCell(3, 8).value = 'maybe'
    })
    await expect(importRatesSheet('v1', buf, 'a')).rejects.toMatchObject({ statusCode: 422, errors: [{ row: 2 }, { row: 3 }] })
    expect(calls.some(c => /INSERT INTO vendor_service_rates|UPDATE/.test(c.sql))).toBe(false)
  })

  it('treats an untouched template as no-op', async () => {
    const { buffer } = await buildRatesTemplate('v1')
    const res = await importRatesSheet('v1', Buffer.from(buffer), 'a')
    expect(res).toEqual({ services_updated: 0, rates_updated: 0, rates_added: 0, unchanged: 3 })
  })
})
