import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/database.js', () => ({ query: vi.fn(), getClient: vi.fn(), pool: {} }))
vi.mock('../../src/utils/audit-log.js', () => ({ emit: () => {}, emitInTx: async () => {}, redact: (x) => x }))
vi.mock('../../src/config/logger.js', () => ({ logger: { warn() {}, info() {}, error() {}, debug() {} } }))
vi.mock('../../src/modules/vendor-counter-orders/vendor-counter-orders.service.js', () => ({ VendorCounterOrdersService: class {} }))
vi.mock('../../src/modules/vendor-pos-catalogue/vendor-pos-catalogue.service.js', () => ({ VendorPosCatalogueService: class {}, normalizeUnit: (x) => x }))

const { checkRow, parseRate } = await import('../../src/modules/vendor-imports/vendor-imports.service.js')
const { VendorPosSettingsService, SETTING_KEYS } = await import('../../src/modules/vendor-pos-settings/vendor-pos-settings.service.js')

describe('import row checks', () => {
  it('reads spreadsheet rates and never turns text into zero', () => {
    expect(parseRate('40')).toBe(40)
    expect(parseRate(' ₹1,200.50 ')).toBe(1200.5)
    expect(parseRate('Rs. 90')).toBe(90)
    expect(parseRate(0)).toBe(0)
    for (const bad of ['abc', '', '12abc', '-5', null, undefined]) expect(parseRate(bad)).toBeNaN()
  })

  it('validates customer rows', () => {
    expect(checkRow('customers', { name: 'Asha', phone: '9111111111' })).toBeNull()
    expect(checkRow('customers', { name: 'Asha', phone: '+91 91111 11111' })).toBeNull()
    expect(checkRow('customers', { name: '', phone: '9111111111' })).toMatch(/name/i)
    expect(checkRow('customers', { name: 'A', phone: '123' })).toMatch(/phone/i)
    expect(checkRow('customers', { name: 'A', phone: '9111111111', email: 'nope' })).toMatch(/e-mail/i)
  })

  it('validates price rows', () => {
    const ok = { garmentName: 'Shirt', serviceName: 'Wash', rate: '40' }
    expect(checkRow('prices', ok)).toBeNull()
    expect(checkRow('prices', { ...ok, rate: 'abc' })).toMatch(/rate/i)
    expect(checkRow('prices', { ...ok, unit: 'Sq.Ft' })).toBeNull()
    expect(checkRow('prices', { ...ok, unit: 'Bundle' })).toMatch(/unit/i)
    expect(checkRow('prices', { ...ok, gstRate: '120' })).toMatch(/gst/i)
    expect(checkRow('prices', { ...ok, customerPhone: '12' })).toMatch(/phone/i)
    expect(checkRow('prices', { ...ok, garmentName: '' })).toMatch(/garment/i)
  })
})

describe('counter settings validation', () => {
  it('rejects unknown keys and wrong shapes before touching the database', async () => {
    const svc = new VendorPosSettingsService()
    const actor = { userId: 'u' }
    expect((await svc.put('v', actor, 'nope', { value: [] })).code).toBe('NOT_FOUND')
    expect((await svc.put('v', actor, 'service-units', { value: {} })).success).toBe(false)
    expect((await svc.put('v', actor, 'print-settings', { value: [] })).success).toBe(false)
    expect((await svc.put('v', actor, 'route-runs', { value: Array(2001).fill(0) })).success).toBe(false)
    expect((await svc.put('v', actor, 'route-runs', { value: [], version: -1 })).success).toBe(false)
  })

  it('knows exactly the settings the counter website stores', () => {
    expect(Object.keys(SETTING_KEYS).sort()).toEqual(['message-templates', 'order-no-series', 'print-settings', 'route-runs', 'service-units', 'service-zones', 'store-packages', 'upi-qr'])
  })
})
