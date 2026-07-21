import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'

// Avoid touching Redis/Postgres/Razorpay during this unit test.
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: null,
}))

const { WEBHOOK_SECRET } = vi.hoisted(() => ({ WEBHOOK_SECRET: 'test-webhook-secret' }))

vi.mock('../../../src/config/env.js', () => ({
  env: { RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET },
}))

import { PaymentsService } from '../../../src/modules/payments/payments.service.js'

function sign(buffer) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(buffer).digest('hex')
}

describe('PaymentsService.handleWebhook — signature verification', () => {
  const stubRepo = {}

  it('accepts a payload whose signature matches the raw bytes exactly', async () => {
    const service = new PaymentsService(stubRepo)
    // A large integer field is the classic case where re-serializing the
    // parsed JSON (JSON.stringify) can produce different bytes than the
    // original payload — this asserts we verify against the raw bytes.
    const rawBuffer = Buffer.from(
      '{"event":"noop.test","payload":{},"note":"unicode-✓","big":123456789012345678}',
      'utf8'
    )
    const signature = sign(rawBuffer)

    const result = await service.handleWebhook(rawBuffer, signature)

    expect(result).toEqual({ success: true })
  })

  it('rejects a signature of the wrong length without throwing', async () => {
    const service = new PaymentsService(stubRepo)
    const rawBuffer = Buffer.from('{"event":"noop.test","payload":{}}', 'utf8')

    const result = await service.handleWebhook(rawBuffer, 'too-short')

    expect(result).toEqual({ success: false })
  })

  it('rejects a same-length but incorrect signature', async () => {
    const service = new PaymentsService(stubRepo)
    const rawBuffer = Buffer.from('{"event":"noop.test","payload":{}}', 'utf8')
    const wrongSignature = sign(Buffer.from('{"event":"tampered","payload":{}}', 'utf8'))

    const result = await service.handleWebhook(rawBuffer, wrongSignature)

    expect(result).toEqual({ success: false })
    expect(wrongSignature.length).toBe(sign(rawBuffer).length)
  })

  it('rejects when the body is tampered with after signing (re-serialization would have masked this)', async () => {
    const service = new PaymentsService(stubRepo)
    const originalBuffer = Buffer.from('{"event":"noop.test","payload":{},"amount":100}', 'utf8')
    const signature = sign(originalBuffer)
    const tamperedBuffer = Buffer.from('{"event":"noop.test","payload":{},"amount":999999}', 'utf8')

    const result = await service.handleWebhook(tamperedBuffer, signature)

    expect(result).toEqual({ success: false })
  })

  it('returns failure without verifying when the webhook secret is not configured', async () => {
    vi.resetModules()
    vi.doMock('../../../src/config/env.js', () => ({ env: { RAZORPAY_WEBHOOK_SECRET: '' } }))
    const { PaymentsService: ServiceWithoutSecret } = await import(
      '../../../src/modules/payments/payments.service.js'
    )
    const service = new ServiceWithoutSecret(stubRepo)

    const result = await service.handleWebhook(Buffer.from('{}', 'utf8'), 'anything')

    expect(result).toEqual({ success: false })
  })
})
