import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShopOrdersService } from '../../../src/modules/shop-orders/service.js'
import * as auditLog from '../../../src/utils/audit-log.js'

// Mock the audit log module to inspect emissions
vi.spyOn(auditLog, 'emitInTx').mockResolvedValue(undefined)

// Mock bullmq config to prevent Redis connection timeouts during tests
vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: {
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
  },
  closeBullMQ: vi.fn().mockResolvedValue(undefined),
}))

function createRepositoryMock() {
  return {
    getClient: vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn(),
    }),
    lockForUpdate: vi.fn(),
    receiveOrderInTx: vi.fn(),
    updateProcessingStageInTx: vi.fn(),
    insertStatusHistoryInTx: vi.fn(),
    updateStatusInTx: vi.fn(),
  }
}

describe('ShopOrdersService Laundry Operations', () => {
  let repository
  let service
  const shopId = 'shop-123'
  const orderId = 'order-456'
  const actor = { id: 'user-789', role: 'VENDOR_OWNER' }

  beforeEach(() => {
    repository = createRepositoryMock()
    service = new ShopOrdersService(repository)
    service._emitSocket = vi.fn()
    vi.clearAllMocks()
  })

  describe('receive', () => {
    it('successfully transitions from CONFIRMED to PREPARING and logs weight/count adjustments', async () => {
      const currentOrder = {
        id: orderId,
        vendor_id: shopId,
        status: 'CONFIRMED',
        estimated_weight: 5.0,
        estimated_garment_count: 10,
        processing_stage: null,
      }

      repository.lockForUpdate.mockResolvedValue(currentOrder)
      repository.receiveOrderInTx.mockResolvedValue({
        id: orderId,
        status: 'PREPARING',
        processingStage: 'Received',
      })

      const data = {
        actualWeight: 5.5,
        weightAdjustmentReason: 'Heavy items',
        actualGarmentCount: 11,
        countAdjustmentReason: 'Extra socks',
      }

      const result = await service.receive(shopId, orderId, data, actor)

      expect(repository.lockForUpdate).toHaveBeenCalled()
      expect(repository.receiveOrderInTx).toHaveBeenCalledWith(expect.any(Object), orderId, data, actor.id)
      expect(repository.insertStatusHistoryInTx).toHaveBeenCalledWith(expect.any(Object), {
        orderId,
        fromStatus: 'CONFIRMED',
        toStatus: 'PREPARING',
        changedBy: actor.id,
        note: expect.any(String),
      })
      expect(auditLog.emitInTx).toHaveBeenCalledWith(expect.any(Object), 'order_status_changed', expect.any(Object))
      expect(auditLog.emitInTx).toHaveBeenCalledWith(expect.any(Object), 'order_weight_adjusted', expect.any(Object))
      expect(auditLog.emitInTx).toHaveBeenCalledWith(expect.any(Object), 'order_count_adjusted', expect.any(Object))
      expect(result.status).toBe('PREPARING')
    })

    it('rejects receiving if order is not in CONFIRMED status', async () => {
      const currentOrder = {
        id: orderId,
        vendor_id: shopId,
        status: 'PENDING',
      }
      repository.lockForUpdate.mockResolvedValue(currentOrder)

      await expect(
        service.receive(shopId, orderId, { actualWeight: 5.5 }, actor)
      ).rejects.toThrow(/Cannot mark order as received/)
    })
  })

  describe('updateProcessingStage', () => {
    it('updates stage sequentially and triggers PACKED transition when Packed is reached', async () => {
      const currentOrder = {
        id: orderId,
        vendor_id: shopId,
        status: 'PREPARING',
        processing_stage: 'Received',
      }

      repository.lockForUpdate.mockResolvedValue(currentOrder)
      repository.updateProcessingStageInTx.mockResolvedValue({
        id: orderId,
        status: 'PACKED',
        processingStage: 'Packed',
      })

      const result = await service.updateProcessingStage(shopId, orderId, 'Packed', actor)

      expect(repository.updateProcessingStageInTx).toHaveBeenCalledWith(expect.any(Object), orderId, 'Packed')
      expect(auditLog.emitInTx).toHaveBeenCalledWith(expect.any(Object), 'order_processing_stage_changed', expect.any(Object))
      expect(result.status).toBe('PACKED')
    })

    it('rejects regressing the processing stage', async () => {
      const currentOrder = {
        id: orderId,
        vendor_id: shopId,
        status: 'PREPARING',
        processing_stage: 'Drying',
      }

      repository.lockForUpdate.mockResolvedValue(currentOrder)

      await expect(
        service.updateProcessingStage(shopId, orderId, 'Washing', actor)
      ).rejects.toThrow(/Cannot regress processing stage/)
    })
  })
})
