import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/database.js', () => ({ query: vi.fn() }))

const { onlineMoney, normalizeMode, VendorFinanceService } = await import('../../src/modules/vendor-finance/vendor-finance.service.js')

describe('onlineMoney — reads an order the way the invoice does', () => {
  it('splits a normal order into the persisted parts and reconciles to the total', () => {
    const m = onlineMoney({
      lines_paise: 20000, payable_amount_paise: 22000,
      fee_breakdown: { delivery_fee_paise: 3000, platform_fee_paise: 1000, tax_paise: 0, discount_paise: 2000 },
    })
    expect(m).toMatchObject({ subtotalPaise: 20000, chargesPaise: 4000, discountPaise: 2000, taxPaise: 0, totalPaise: 22000, adjustmentPaise: 0 })
  })
  it('takes the GST rate from the fee line, else from the amounts', () => {
    const withLine = onlineMoney({ lines_paise: 10000, payable_amount_paise: 11800, fee_breakdown: { tax_paise: 1800, canonical_breakdown: { fees: [{ code: 'GST', metadata: { rate: 18 } }] } } })
    expect(withLine.ratePercent).toBe(18)
    const implied = onlineMoney({ lines_paise: 10000, payable_amount_paise: 10500, fee_breakdown: { tax_paise: 500 } })
    expect(implied.ratePercent).toBe(5)
  })
  it('a re-evaluated order carries no tax / discount / express, like its invoice', () => {
    const m = onlineMoney({ lines_paise: 9000, payable_amount_paise: 9500, fee_breakdown: { original_subtotal_paise: 10000, delivery_fee_paise: 500, tax_paise: 1800, discount_paise: 1000, express_fee_paise: 700 } })
    expect(m).toMatchObject({ taxPaise: 0, discountPaise: 0, expressPaise: 0, chargesPaise: 500, adjustmentPaise: 0 })
  })
  it('falls back to rupee columns on old orders', () => {
    const m = onlineMoney({ subtotal: '100.00', total_amount: '118.00', tax_amount: '18.00', fee_breakdown: {} })
    expect(m).toMatchObject({ subtotalPaise: 10000, taxPaise: 1800, totalPaise: 11800 })
  })
})

describe('normalizeMode', () => {
  it.each([['cash', 'CASH'], ['COD', 'CASH'], ['upi', 'UPI'], ['card', 'CARD'], ['netbanking', 'BANK'], ['BANK_TRANSFER', 'BANK'], ['WALLET', 'WALLET'], ['razorpay', 'ONLINE'], ['weird', 'OTHER'], [null, 'OTHER']])('%s -> %s', (raw, mode) => {
    expect(normalizeMode(raw)).toBe(mode)
  })
})

describe('period + channel rules', () => {
  const service = new VendorFinanceService({})
  it('rejects bad periods', () => {
    expect(service._period('2026-09-10', '2026-09-01').success).toBe(false)
    expect(service._period('nope', '2026-09-01').success).toBe(false)
    expect(service._period('2020-01-01', '2026-09-01').success).toBe(false)
    expect(service._period('2026-09-01', '2026-09-21')).toEqual({ from: '2026-09-01', to: '2026-09-21' })
  })
  it('connection comes from the vendor record, and All falls back to POS when not connected', () => {
    expect(service._marketplace({ vendor_approved: true, account_enabled: true, is_active: true, online_order_count: 0 }).connected).toBe(true)
    expect(service._marketplace({ vendor_approved: false, account_enabled: true, is_active: true, online_order_count: 0 }).connected).toBe(false)
    expect(service._marketplace({ vendor_approved: false, online_order_count: 3 }).connected).toBe(true)
    expect(service._marketplace({ vendor_approved: true, account_enabled: false, is_active: true, online_order_count: 0 }).connected).toBe(false)
    expect(service._channels('ALL', false)).toMatchObject({ effective: 'POS', pos: true, online: false })
    expect(service._channels('ALL', true)).toMatchObject({ effective: 'ALL', pos: true, online: true })
    expect(service._channels('ONLINE', true)).toMatchObject({ pos: false, online: true })
  })
})
