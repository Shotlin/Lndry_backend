import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
}))

import { VendorOrdersService } from '../../src/modules/vendor-orders/vendor-orders.service.js'

/**
 * Evidence read path added to getOrder(): previously the only readable
 * photos anywhere in this backend were the ones scoped to the LATEST
 * reconciliation (order_pickup_photos WHERE order_reconciliation_id = $1).
 * Rider pickup proof (context RIDER_PICKUP, written by
 * vendor-rider.service.js#submitPickupPhotos) and delivery proof (context
 * DELIVERY_PROOF) were written but never selectable by any client. This adds
 * one additional, order-scoped (not reconciliation-scoped) query so a vendor
 * can read back everything ever attached to their own order.
 */
describe('VendorOrdersService.getOrder — evidence read path', () => {
  const USER_ID = 'user-vendor-owner'
  const VENDOR_ID = 'vendor-uuid-1'
  const ORDER_ID = 'order-uuid-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the full cross-context evidence history for this order, tenant-scoped', async () => {
    const service = new VendorOrdersService()

    mockQuery
      .mockResolvedValueOnce({ rows: [{ vendor_id: VENDOR_ID, role: 'VENDOR_OWNER' }] }) // _resolveVendorId
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, vendor_id: VENDOR_ID, status: 'DELIVERED' }] }) // main order select
      .mockResolvedValueOnce({ rows: [] }) // lines
      .mockResolvedValueOnce({ rows: [] }) // events/timeline
      .mockResolvedValueOnce({ rows: [{ amount_paid: '0' }] }) // paid
      .mockResolvedValueOnce({ rows: [] }) // no reconciliation row for this order
      .mockResolvedValueOnce({
        rows: [
          { photo_url: 'https://cdn/pickup-1.jpg', context: 'RIDER_PICKUP', order_line_id: null, is_grouped: false, created_at: '2026-09-01T10:00:00Z', uploaded_by: 'rider-1', uploaded_by_name: 'Ravi Rider' },
          { photo_url: 'https://cdn/delivery-1.jpg', context: 'DELIVERY_PROOF', order_line_id: null, is_grouped: false, created_at: '2026-09-02T18:00:00Z', uploaded_by: 'rider-1', uploaded_by_name: 'Ravi Rider' },
        ],
      }) // evidence

    const order = await service.getOrder(USER_ID, ORDER_ID)

    expect(order.evidence).toHaveLength(2)
    expect(order.evidence.map((row) => row.context)).toEqual(['RIDER_PICKUP', 'DELIVERY_PROOF'])
    expect(order.evidence[0].uploaded_by_name).toBe('Ravi Rider')

    // The evidence query is scoped by order_id, not by vendor_id directly —
    // correct because orderId was already resolved against THIS vendor by the
    // main order query's `o.vendor_id = $2` filter above it; a cross-vendor
    // orderId would already have 404'd before this query ever runs.
    const evidenceCall = mockQuery.mock.calls.find((call) => call[0].includes('order_pickup_photos') && call[0].includes('opp.order_id = $1'))
    expect(evidenceCall).toBeDefined()
    expect(evidenceCall[1]).toEqual([ORDER_ID])
  })

  it('does not require a reconciliation to exist, and leaves latestReconciliation null when there is none', async () => {
    const service = new VendorOrdersService()

    mockQuery
      .mockResolvedValueOnce({ rows: [{ vendor_id: VENDOR_ID, role: 'VENDOR_OWNER' }] })
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, vendor_id: VENDOR_ID, status: 'WAITING_VENDOR_CONFIRMATION' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ amount_paid: '0' }] })
      .mockResolvedValueOnce({ rows: [] }) // no reconciliation
      .mockResolvedValueOnce({ rows: [] }) // no evidence yet either

    const order = await service.getOrder(USER_ID, ORDER_ID)

    expect(order.latestReconciliation).toBeNull()
    expect(order.evidence).toEqual([])
  })

  it('keeps latestReconciliation.photos scoped to the latest reconciliation only, separate from the full evidence history', async () => {
    const service = new VendorOrdersService()
    const RECON_ID = 'recon-uuid-1'

    mockQuery
      .mockResolvedValueOnce({ rows: [{ vendor_id: VENDOR_ID, role: 'VENDOR_OWNER' }] })
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, vendor_id: VENDOR_ID, status: 'RECONCILIATION_PENDING' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ amount_paid: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: RECON_ID, status: 'PENDING_CUSTOMER' }] }) // latest reconciliation
      .mockResolvedValueOnce({ rows: [{ photo_url: 'https://cdn/recon-only.jpg' }] }) // reconciliation-scoped photos
      .mockResolvedValueOnce({
        rows: [
          { photo_url: 'https://cdn/pickup-old.jpg', context: 'RIDER_PICKUP', order_line_id: null, is_grouped: false, created_at: '2026-08-01T00:00:00Z', uploaded_by: 'rider-1', uploaded_by_name: 'Ravi Rider' },
          { photo_url: 'https://cdn/recon-only.jpg', context: 'VENDOR_RECONCILIATION', order_line_id: null, is_grouped: true, created_at: '2026-09-01T00:00:00Z', uploaded_by: USER_ID, uploaded_by_name: null },
        ],
      }) // full evidence history — includes the reconciliation photo too, plus the older pickup one

    const order = await service.getOrder(USER_ID, ORDER_ID)

    expect(order.latestReconciliation.photos).toEqual(['https://cdn/recon-only.jpg'])
    expect(order.evidence).toHaveLength(2)
    expect(order.evidence.map((row) => row.context)).toEqual(['RIDER_PICKUP', 'VENDOR_RECONCILIATION'])
  })
})
