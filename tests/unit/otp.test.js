import { describe, expect, it, vi, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'

const mockQuery = vi.fn()
vi.mock('../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
}))

import { OrderOtpService } from '../../src/modules/order-otp/order-otp.service.js'

describe('OrderOtpService — Verification Rules', () => {
  let service
  const ORDER_ID = '550e8400-e29b-41d4-a716-446655440000'
  const RAW_OTP = '123456'

  beforeEach(() => {
    service = new OrderOtpService()
    vi.clearAllMocks()
  })

  it('fails if no active OTP matches the order and purpose', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }) // No active OTP

    await expect(
      service.verifyOtp(ORDER_ID, 'DELIVERY', RAW_OTP)
    ).rejects.toMatchObject({
      code: 'OTP_NOT_FOUND',
      statusCode: 400,
    })
  })

  it('fails if the OTP has expired', async () => {
    const expiredTime = new Date(Date.now() - 1000)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          order_id: ORDER_ID,
          purpose: 'PICKUP',
          otp_hash: await bcrypt.hash(RAW_OTP, 12),
          attempt_count: 0,
          expires_at: expiredTime,
          used_at: null,
        },
      ],
    })

    await expect(
      service.verifyOtp(ORDER_ID, 'PICKUP', RAW_OTP)
    ).rejects.toMatchObject({
      code: 'OTP_EXPIRED',
      statusCode: 400,
    })
  })

  it('fails if the OTP is already used (used_at is not null)', async () => {
    // If it is already used, it is not returned by the SELECT query because of the WHERE used_at IS NULL condition.
    // So the service throws OTP_NOT_FOUND
    mockQuery.mockResolvedValueOnce({ rows: [] })

    await expect(
      service.verifyOtp(ORDER_ID, 'PICKUP', RAW_OTP)
    ).rejects.toMatchObject({
      code: 'OTP_NOT_FOUND',
      statusCode: 400,
    })
  })

  it('succeeds for a valid, non-expired OTP with matching purpose', async () => {
    const futureTime = new Date(Date.now() + 600000) // 10m
    const hashedOtp = await bcrypt.hash(RAW_OTP, 12)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          order_id: ORDER_ID,
          purpose: 'PICKUP',
          otp_hash: hashedOtp,
          attempt_count: 0,
          expires_at: futureTime,
          used_at: null,
        },
      ],
    })

    // Mock successful database updates
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await service.verifyOtp(ORDER_ID, 'PICKUP', RAW_OTP)
    expect(result.success).toBe(true)
  })

  it('fails on wrong OTP and increments attempt count', async () => {
    const futureTime = new Date(Date.now() + 600000)
    const hashedOtp = await bcrypt.hash(RAW_OTP, 12)
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          order_id: ORDER_ID,
          purpose: 'PICKUP',
          otp_hash: hashedOtp,
          attempt_count: 2,
          expires_at: futureTime,
          used_at: null,
        },
      ],
    })

    mockQuery.mockResolvedValue({ rows: [] })

    await expect(
      service.verifyOtp(ORDER_ID, 'PICKUP', 'wrongotp')
    ).rejects.toMatchObject({
      code: 'INVALID_OTP',
      attemptsRemaining: 2, // 5 - (2+1) = 2
    })
  })
})
