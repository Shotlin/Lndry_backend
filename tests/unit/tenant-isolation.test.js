import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
}))

import { VendorOrdersService } from '../../src/modules/vendor-orders/vendor-orders.service.js'

describe('Tenant Isolation Unit Tests', () => {
  let service
  const USER_VENDOR_A = 'user-vendor-a-id'
  const VENDOR_A = 'vendor-a-uuid'
  const VENDOR_B = 'vendor-b-uuid'
  const ORDER_B = 'order-b-uuid'

  beforeEach(() => {
    service = new VendorOrdersService()
    vi.clearAllMocks()
  })

  it('fails to fetch an order if it belongs to another vendor', async () => {
    // 1. Mock _resolveVendorId to resolve USER_VENDOR_A to VENDOR_A
    // Check is for vendor employee / owner (single query)
    mockQuery.mockResolvedValueOnce({
      rows: [{ vendor_id: VENDOR_A, role: 'VENDOR_STAFF' }]
    })

    // 2. Mock getOrder query to return nothing because VENDOR_A is querying ORDER_B
    mockQuery.mockResolvedValueOnce({ rows: [] }) // No order matches ORDER_B + VENDOR_A

    await expect(
      service.getOrder(USER_VENDOR_A, ORDER_B)
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND'
    })

    // Assert that the query used VENDOR_A, not VENDOR_B
    const getOrderCall = mockQuery.mock.calls.find(call => call[0].includes('o.vendor_id = $2'))
    expect(getOrderCall).toBeDefined()
    expect(getOrderCall[1]).toEqual([ORDER_B, VENDOR_A])
  })
})
