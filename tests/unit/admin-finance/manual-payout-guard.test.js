import { describe, expect, it, vi } from 'vitest'
import { AdminFinanceService } from '../../../src/modules/admin/finance/service.js'

describe('AdminFinanceService legacy manual payout guard', () => {
  it('fails closed without reading or mutating a financial period', async () => {
    const repository = {
      findFinancialByIdAndShop: vi.fn(),
    }
    const service = new AdminFinanceService(repository)

    const result = await service.markPaid(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333'
    )

    expect(result).toEqual({
      ok: false,
      code: 'PAYOUT_PROVIDER_EVIDENCE_REQUIRED',
      message:
        'A payout cannot be marked paid manually. Configure a provider workflow that records external payment evidence.',
    })
    expect(repository.findFinancialByIdAndShop).not.toHaveBeenCalled()
  })
})
