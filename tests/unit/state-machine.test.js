import { describe, expect, it } from 'vitest'
import {
  orderStateMachine,
  ORDER_STATUSES,
  validateTransition,
  assertTransition,
} from '../../src/utils/state-machine.js'

describe('Order State Machine — Transitions & Roles', () => {
  describe('validateTransition()', () => {
    it('allows same-state self transitions (noop)', () => {
      const result = validateTransition(ORDER_STATUSES.PACKED, ORDER_STATUSES.PACKED, 'VENDOR_STAFF')
      expect(result.valid).toBe(true)
    })

    it('allows valid sequential transitions (e.g. PACKED -> OUT_FOR_DELIVERY by RIDER)', () => {
      const result = validateTransition(ORDER_STATUSES.PACKED, ORDER_STATUSES.OUT_FOR_DELIVERY, 'RIDER')
      expect(result.valid).toBe(true)
    })

    it('rejects invalid sequential transitions (e.g. PACKED -> PAYMENT_PENDING)', () => {
      const result = validateTransition(ORDER_STATUSES.PACKED, ORDER_STATUSES.PAYMENT_PENDING, 'VENDOR_STAFF')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('Invalid state transition')
    })

    it('rejects unauthorized roles for transitions (e.g. RECEIVED_AT_VENDOR -> PROCESSING by RIDER)', () => {
      const result = validateTransition(ORDER_STATUSES.RECEIVED_AT_VENDOR, ORDER_STATUSES.PROCESSING, 'RIDER')
      expect(result.valid).toBe(false)
      expect(result.message).toContain('Forbidden')
    })

    it('Vendor actions: RECEIVED_AT_VENDOR -> PROCESSING -> PACKED', () => {
      // VENDOR_STAFF initiates processing
      const result = validateTransition(ORDER_STATUSES.RECEIVED_AT_VENDOR, ORDER_STATUSES.PROCESSING, 'VENDOR_STAFF')
      expect(result.valid).toBe(true)

      // RIDER cannot initiate processing
      const badResult = validateTransition(ORDER_STATUSES.RECEIVED_AT_VENDOR, ORDER_STATUSES.PROCESSING, 'RIDER')
      expect(badResult.valid).toBe(false)
    })
  })

  describe('assertTransition()', () => {
    it('throws custom error on invalid transition', () => {
      expect(() => {
        assertTransition(ORDER_STATUSES.PACKED, ORDER_STATUSES.PAYMENT_PENDING, 'VENDOR_STAFF')
      }).toThrow()

      try {
        assertTransition(ORDER_STATUSES.PACKED, ORDER_STATUSES.PAYMENT_PENDING, 'VENDOR_STAFF')
      } catch (err) {
        expect(err.statusCode).toBe(409)
        expect(err.code).toBe('ORDER_STATE_INVALID')
      }
    })

    it('does not throw on valid transition', () => {
      expect(() => {
        assertTransition(ORDER_STATUSES.RECEIVED_AT_VENDOR, ORDER_STATUSES.PROCESSING, 'VENDOR_STAFF')
      }).not.toThrow()
    })
  })
})
