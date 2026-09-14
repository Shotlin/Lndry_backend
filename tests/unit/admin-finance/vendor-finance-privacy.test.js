import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()

vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
}))

import { AdminFinanceRepository } from '../../../src/modules/admin/finance/repository.js'

describe('AdminFinanceRepository vendor finance overview privacy', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('exposes payout readiness without returning vendor bank account details', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Verified vendor',
          commission_rate: '12.00',
          is_active: true,
          payout_bank_ready: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })

    const repository = new AdminFinanceRepository()
    const result = await repository.findShops({ page: 1, limit: 20 })

    expect(result.items[0]).toEqual(expect.objectContaining({
      payout_bank_ready: true,
    }))
    expect(result.items[0]).not.toHaveProperty('bank_account_number')
    expect(result.items[0]).not.toHaveProperty('bank_ifsc')
    expect(result.items[0]).not.toHaveProperty('bank_name')
    expect(result.items[0]).not.toHaveProperty('bank_holder_name')

    const overviewSql = mockQuery.mock.calls[0][0]
    expect(overviewSql).toContain('AS payout_bank_ready')
    expect(overviewSql).not.toMatch(/s\.bank_account_number\s*,\s*s\.bank_ifsc/)
  })
})
