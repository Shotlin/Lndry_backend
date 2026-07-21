/**
 * Canonical LNDRY Order Status constants.
 *
 * This file re-exports ORDER_STATUSES from the state machine for backward
 * compatibility with modules that import from here. New code should import
 * directly from '../../utils/state-machine.js'.
 */
import { ORDER_STATUSES } from '../utils/state-machine.js'

export const ORDER_STATUS = {
  ...ORDER_STATUSES,
  // Legacy aliases used by the old legacy-era code, kept for backward compat
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PREPARING: 'PREPARING',
}

export const ACTIVE_ORDER_STATUSES = [
  ORDER_STATUSES.PAYMENT_PENDING,
  ORDER_STATUSES.PAYMENT_CONFIRMED,
  ORDER_STATUSES.WAITING_VENDOR_CONFIRMATION,
  ORDER_STATUSES.VENDOR_ACCEPTED,
  ORDER_STATUSES.PICKUP_ASSIGNED,
  ORDER_STATUSES.GOING_FOR_PICKUP,
  ORDER_STATUSES.PICKUP_OTP_VERIFIED,
  ORDER_STATUSES.PICKED_UP,
  ORDER_STATUSES.RECEIVED_AT_VENDOR,
  ORDER_STATUSES.PROCESSING,
  ORDER_STATUSES.PACKED,
  ORDER_STATUSES.DELIVERY_ASSIGNED,
  ORDER_STATUSES.OUT_FOR_DELIVERY,
  ORDER_STATUSES.DELIVERY_OTP_VERIFIED,
]

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
}
