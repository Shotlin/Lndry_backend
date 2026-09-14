import { describe, expect, it } from 'vitest'
import { blockLegacyAdminOrderMutation, LEGACY_ADMIN_ORDER_WRITES_BLOCKED } from './orders.lifecycle-guard.js'

describe('legacy admin order mutation guard', () => {
  it('fails closed with an explicit lifecycle-convergence error', async () => {
    const reply = {
      statusCode: 0,
      payload: undefined,
      code(statusCode) { this.statusCode = statusCode; return this },
      send(payload) { this.payload = payload; return this },
    }

    await blockLegacyAdminOrderMutation({}, reply)

    expect(reply.statusCode).toBe(409)
    expect(reply.payload).toMatchObject({
      success: false,
      code: LEGACY_ADMIN_ORDER_WRITES_BLOCKED,
      error: { code: LEGACY_ADMIN_ORDER_WRITES_BLOCKED },
    })
  })
})
