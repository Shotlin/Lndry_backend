import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))
vi.mock('../../src/utils/cache.js', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn(), cacheDel: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/config/database.js', () => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../src/middlewares/vendor-permission.js', () => ({ loadVendorActor: vi.fn() }))

const { query } = await import('../../src/config/database.js')
const { loadVendorActor } = await import('../../src/middlewares/vendor-permission.js')
const offering = await import('../../src/modules/vendor-app-mode/offering.js')
const { VendorAppModeService, STEP_VALIDATORS } = await import('../../src/modules/vendor-app-mode/vendor-app-mode.service.js')

describe('allowedModesFor', () => {
  it('MARKETPLACE vendors only ever get marketplace', () => {
    expect(offering.allowedModesFor('MARKETPLACE', 'NOT_STARTED')).toEqual(['MARKETPLACE'])
    expect(offering.allowedModesFor('MARKETPLACE', 'COMPLETED')).toEqual(['MARKETPLACE'])
  })
  it('POS appears only after POS onboarding is COMPLETED', () => {
    expect(offering.allowedModesFor('POS', 'NOT_STARTED')).toEqual([])
    expect(offering.allowedModesFor('POS', 'IN_PROGRESS')).toEqual([])
    expect(offering.allowedModesFor('POS', 'COMPLETED')).toEqual(['POS'])
  })
  it('BOTH keeps marketplace usable while POS is being set up', () => {
    expect(offering.allowedModesFor('BOTH', 'IN_PROGRESS')).toEqual(['MARKETPLACE'])
    expect(offering.allowedModesFor('BOTH', 'COMPLETED')).toEqual(['MARKETPLACE', 'POS'])
  })
})

describe('normalizeOffering', () => {
  it('accepts the three values case-insensitively and rejects anything else', () => {
    expect(offering.normalizeOffering(' both ')).toBe('BOTH')
    expect(offering.normalizeOffering('pos')).toBe('POS')
    for (const bad of ['', null, undefined, 'ALL', 'STANDARD']) expect(offering.normalizeOffering(bad)).toBeNull()
  })
})

describe('productForPath / offeringAllows', () => {
  it.each([
    ['/api/v1/vendor/counter/orders', 'POS'],
    ['/api/v1/vendor/counter', 'POS'],
    ['/api/v1/vendor/pos/dashboard?x=1', 'POS'],
    ['/api/v1/vendor/pos-catalogue', 'POS'],
    ['/api/v1/vendor/cash-shifts/current', 'POS'],
    ['/api/v1/vendor/orders', 'MARKETPLACE'],
    ['/api/v1/vendor/orders/123/accept', 'MARKETPLACE'],
    ['/api/v1/vendor-orders', 'MARKETPLACE'],
    ['/api/v1/vendor/rider/jobs', 'MARKETPLACE'],
  ])('%s belongs to %s', (path, product) => expect(offering.productForPath(path)).toBe(product))

  it.each([
    '/api/v1/vendor/app-mode', '/api/v1/vendor/pos-onboarding', '/api/v1/vendor/profile', '/api/v1/vendor/applications/me',
    '/api/v1/vendor/employees', '/api/v1/auth/my-roles', '/api/v1/vendor/posted', '/api/v1/vendor/counters', '/api/v1/vendor/ordersx',
  ])('%s is never gated (prefix match must be on a path boundary)', (path) => expect(offering.productForPath(path)).toBeNull())

  it('entitlement matrix', () => {
    expect(offering.offeringAllows('BOTH', 'POS')).toBe(true)
    expect(offering.offeringAllows('BOTH', 'MARKETPLACE')).toBe(true)
    expect(offering.offeringAllows('POS', 'POS')).toBe(true)
    expect(offering.offeringAllows('POS', 'MARKETPLACE')).toBe(false)
    expect(offering.offeringAllows('MARKETPLACE', 'POS')).toBe(false)
    expect(offering.offeringAllows('MARKETPLACE', 'MARKETPLACE')).toBe(true)
  })
})

describe('onboarding step validators', () => {
  const shop = { name: 'Sparkle Laundry', ownerName: 'Ravi Kumar', addressLine1: '12 MG Road', city: 'Pune' }

  it('shop: accepts a valid shop and normalises whitespace', () => {
    const r = STEP_VALIDATORS.shop({ ...shop, name: '  Sparkle   Laundry ', pincode: '411001', state: 'MH' })
    expect(r.value).toMatchObject({ name: 'Sparkle Laundry', pincode: '411001', state: 'MH' })
  })
  it.each([
    [{ name: 'A' }, /shop name/],
    [{ ownerName: '' }, /owner name/],
    [{ addressLine1: 'x' }, /address/],
    [{ city: '' }, /city/],
    [{ pincode: '12345' }, /6 digits/],
    [{ pincode: '41100a' }, /6 digits/],
  ])('shop: rejects %j', (patch, message) => expect(STEP_VALIDATORS.shop({ ...shop, ...patch }).error).toMatch(message))
  it('shop: ignores non-string garbage instead of throwing', () => {
    expect(STEP_VALIDATORS.shop({ name: 5, ownerName: {}, addressLine1: [], city: null }).error).toBeTruthy()
    expect(STEP_VALIDATORS.shop({}).error).toBeTruthy()
  })

  it('tax: GST off needs nothing; gstin is dropped', () => {
    expect(STEP_VALIDATORS.tax({ gstEnabled: false, gstin: 'whatever' }).value).toEqual({ gstEnabled: false, gstin: null, upiId: null, currency: 'INR', invoicePrefix: 'INV' })
  })
  it('tax: GST on requires a valid GSTIN (uppercased) ', () => {
    expect(STEP_VALIDATORS.tax({ gstEnabled: true, gstin: '27abcde1234f1z5' }).value.gstin).toBe('27ABCDE1234F1Z5')
    expect(STEP_VALIDATORS.tax({ gstEnabled: true, gstin: 'BADGSTIN' }).error).toMatch(/GSTIN/)
    expect(STEP_VALIDATORS.tax({ gstEnabled: true }).error).toMatch(/GSTIN/)
  })
  it('tax: gstEnabled must be literally true (a string "true" is not accepted)', () => {
    expect(STEP_VALIDATORS.tax({ gstEnabled: 'true', gstin: '27ABCDE1234F1Z5' }).value.gstEnabled).toBe(false)
  })
  it.each([['ravi@okbank', true], ['ravi.k-1_x@ybl', true], ['ravi', false], ['@okbank', false], ['ravi@1', false], ['a b@bank', false]])(
    'tax: UPI %s valid=%s', (upiId, ok) => expect(Boolean(STEP_VALIDATORS.tax({ upiId }).value)).toBe(ok))
  it('tax: only INR; prefix upper-cased and limited to 6 alphanumerics', () => {
    expect(STEP_VALIDATORS.tax({ currency: 'usd' }).error).toMatch(/INR/)
    expect(STEP_VALIDATORS.tax({ invoicePrefix: 'spk' }).value.invoicePrefix).toBe('SPK')
    expect(STEP_VALIDATORS.tax({ invoicePrefix: 'TOO-LONG1' }).error).toMatch(/prefix/)
  })

  it('counter: defaults and bounds', () => {
    expect(STEP_VALIDATORS.counter({}).value).toEqual({ printerProfile: 'none', orderSeriesPrefix: 'LN', defaultDeliveryDays: 3 })
    expect(STEP_VALIDATORS.counter({ defaultDeliveryDays: 0 }).value.defaultDeliveryDays).toBe(0)
    expect(STEP_VALIDATORS.counter({ defaultDeliveryDays: 31 }).error).toMatch(/0 and 30/)
    expect(STEP_VALIDATORS.counter({ defaultDeliveryDays: 1.5 }).error).toBeTruthy()
    expect(STEP_VALIDATORS.counter({ defaultDeliveryDays: 'abc' }).error).toBeTruthy()
    expect(STEP_VALIDATORS.counter({ printerProfile: 'laser-9000' }).error).toMatch(/printer/i)
  })

  it('pricelist: only starter or own', () => {
    expect(STEP_VALIDATORS.pricelist({ choice: 'Starter' }).value).toEqual({ choice: 'starter' })
    expect(STEP_VALIDATORS.pricelist({ choice: 'own' }).value).toEqual({ choice: 'own' })
    expect(STEP_VALIDATORS.pricelist({ choice: 'both' }).error).toBeTruthy()
    expect(STEP_VALIDATORS.pricelist({}).error).toBeTruthy()
  })
})

describe('VendorAppModeService (mocked database)', () => {
  const row = (over = {}) => ({ id: 'v1', name: 'Shop', offering: 'POS', pos_onboarding_status: 'IN_PROGRESS', pos_plan_name: null, pos_valid_to: null, pos_onboarding_data: {}, vendor_type: 'STANDARD', ...over })
  let service
  beforeEach(() => {
    vi.clearAllMocks()
    service = new VendorAppModeService({ catalogue: { createService: vi.fn(), createCategory: vi.fn(), createGarment: vi.fn(), createPrice: vi.fn() } })
  })

  it('getAppMode: a user who is on no roster gets hasVendor=false and canStartPos', async () => {
    loadVendorActor.mockResolvedValue(null)
    const res = await service.getAppMode({ id: 'u1' })
    expect(res.appMode).toMatchObject({ hasVendor: false, offering: null, allowedModes: [], canStartPos: true })
  })

  it('getAppMode: reports capabilities from vendor_type, never from offering', async () => {
    loadVendorActor.mockResolvedValue({ vendorId: 'v1', role: 'VENDOR_OWNER', permissions: [] })
    query.mockResolvedValue({ rows: [row({ offering: 'BOTH', pos_onboarding_status: 'COMPLETED', vendor_type: 'PARTNER', pos_valid_to: '2026-11-03' })] })
    const { appMode } = await service.getAppMode({ id: 'u1' })
    expect(appMode).toMatchObject({ allowedModes: ['MARKETPLACE', 'POS'], appSync: true, walletAccess: true, posValidTo: '2026-11-03', needsPosOnboarding: false, canStartPos: false })
  })

  it('getAppMode: a marketplace vendor is offered the chance to start POS', async () => {
    loadVendorActor.mockResolvedValue({ vendorId: 'v1', role: 'VENDOR_OWNER', permissions: [] })
    query.mockResolvedValue({ rows: [row({ offering: 'MARKETPLACE', pos_onboarding_status: 'NOT_STARTED' })] })
    const { appMode } = await service.getAppMode({ id: 'u1' })
    expect(appMode).toMatchObject({ allowedModes: ['MARKETPLACE'], canStartPos: true, needsPosOnboarding: false })
  })

  it('start: staff and captains cannot start POS for the shop', async () => {
    for (const role of ['VENDOR_STAFF', 'VENDOR_RIDER']) {
      loadVendorActor.mockResolvedValue({ vendorId: 'v1', role, permissions: [] })
      const res = await service.start({ id: 'u1' })
      expect(res).toMatchObject({ success: false, status: 403, code: 'NOT_OWNER' })
    }
  })

  it('saveStep: unknown step and not-started shops are refused before anything is written', async () => {
    expect(await service.saveStep('v1', {}, 'bogus', {})).toMatchObject({ success: false, code: 'UNKNOWN_STEP' })
    query.mockResolvedValue({ rows: [row({ offering: 'MARKETPLACE', pos_onboarding_status: 'NOT_STARTED' })] })
    expect(await service.saveStep('v1', {}, 'shop', { name: 'x' })).toMatchObject({ success: false, status: 409, code: 'POS_NOT_STARTED' })
    expect(query).toHaveBeenCalledTimes(1) // only the SELECT — no UPDATE
  })

  it('saveStep: invalid data is rejected with a plain message and nothing is written', async () => {
    query.mockResolvedValue({ rows: [row()] })
    const res = await service.saveStep('v1', {}, 'tax', { gstEnabled: true, gstin: 'nope' })
    expect(res).toMatchObject({ success: false, code: 'VALIDATION_ERROR' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('saveStep: non-object data does not crash', async () => {
    query.mockResolvedValue({ rows: [row()] })
    for (const bad of [undefined, null, 'str', 5, []]) {
      const res = await service.saveStep('v1', {}, 'pricelist', bad)
      expect(res.success).toBe(false)
    }
  })

  it('complete: lists exactly which steps are missing', async () => {
    query.mockResolvedValue({ rows: [row({ pos_onboarding_data: { shop: {}, tax: {} } })] })
    const res = await service.complete('v1', {})
    expect(res).toMatchObject({ success: false, code: 'ONBOARDING_INCOMPLETE', missingSteps: ['counter', 'pricelist'] })
  })

  it('complete: choosing "own" skips the starter price list entirely', async () => {
    const data = { shop: {}, tax: {}, counter: {}, pricelist: { choice: 'own' } }
    query.mockImplementation(async (sql) => (/^\s*SELECT/i.test(sql) ? { rows: [row({ pos_onboarding_data: data })] } : { rows: [] }))
    const res = await service.complete('v1', { userId: 'u1' })
    expect(res.success).toBe(true)
    expect(res.starterPricelist).toBeNull()
    expect(service.catalogue.createService).not.toHaveBeenCalled()
  })

  it('complete: a starter price list failure is reported cleanly and the shop is NOT marked completed', async () => {
    const data = { shop: {}, tax: {}, counter: {}, pricelist: { choice: 'starter' } }
    const updates = []
    query.mockImplementation(async (sql) => { if (/^\s*UPDATE/i.test(sql)) updates.push(sql); return { rows: /^\s*SELECT/i.test(sql) ? [row({ pos_onboarding_data: data })] : [] } })
    service.catalogue.createService.mockResolvedValue({ success: false, code: 'VALIDATION_ERROR', message: 'boom' })
    const res = await service.complete('v1', {})
    expect(res).toMatchObject({ success: false, code: 'STARTER_PRICELIST_FAILED', status: 500 })
    expect(updates).toHaveLength(0)
  })
})
