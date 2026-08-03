export const ORDER_STATUSES = {
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  WAITING_VENDOR_CONFIRMATION: 'WAITING_VENDOR_CONFIRMATION',
  VENDOR_ACCEPTED: 'VENDOR_ACCEPTED',
  PICKUP_ASSIGNED: 'PICKUP_ASSIGNED',
  GOING_FOR_PICKUP: 'GOING_FOR_PICKUP',
  PICKUP_OTP_VERIFIED: 'PICKUP_OTP_VERIFIED',
  PICKED_UP: 'PICKED_UP',
  RECEIVED_AT_VENDOR: 'RECEIVED_AT_VENDOR',
  // Vendor submitted a corrected weight/count with photo evidence; order
  // pauses here until the customer accepts or rejects it, before washing starts.
  RECONCILIATION_PENDING: 'RECONCILIATION_PENDING',
  RECONCILIATION_DISPUTED: 'RECONCILIATION_DISPUTED',
  PROCESSING: 'PROCESSING',
  PACKED: 'PACKED',
  DELIVERY_ASSIGNED: 'DELIVERY_ASSIGNED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERY_OTP_VERIFIED: 'DELIVERY_OTP_VERIFIED',
  DELIVERED: 'DELIVERED',

  // Failure terminal states
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  VENDOR_REJECTED: 'VENDOR_REJECTED',
  AUTO_REJECTED: 'AUTO_REJECTED',
  CUSTOMER_CANCELLED: 'CUSTOMER_CANCELLED',
  ADMIN_CANCELLED: 'ADMIN_CANCELLED',
  REFUNDED: 'REFUNDED'
}

export const PROCESSING_STAGES = {
  RECEIVED: 'Received',
  WASHING: 'Washing',
  DRYING: 'Drying',
  IRONING: 'Ironing',
  PACKED: 'Packed'
}

// Maps source status to permitted next statuses (17-state sequential machine)
const TRANSITION_RULES = {
  [ORDER_STATUSES.PAYMENT_PENDING]: [
    ORDER_STATUSES.PAYMENT_CONFIRMED,
    ORDER_STATUSES.PAYMENT_FAILED,
    ORDER_STATUSES.CUSTOMER_CANCELLED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.PAYMENT_CONFIRMED]: [
    ORDER_STATUSES.WAITING_VENDOR_CONFIRMATION,
    ORDER_STATUSES.CUSTOMER_CANCELLED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.WAITING_VENDOR_CONFIRMATION]: [
    ORDER_STATUSES.VENDOR_ACCEPTED,
    ORDER_STATUSES.VENDOR_REJECTED,
    ORDER_STATUSES.AUTO_REJECTED,
    ORDER_STATUSES.CUSTOMER_CANCELLED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.VENDOR_ACCEPTED]: [
    ORDER_STATUSES.PICKUP_ASSIGNED,
    ORDER_STATUSES.GOING_FOR_PICKUP,
    ORDER_STATUSES.RECEIVED_AT_VENDOR, // Direct self-pickup bypass
    ORDER_STATUSES.CUSTOMER_CANCELLED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.PICKUP_ASSIGNED]: [
    ORDER_STATUSES.GOING_FOR_PICKUP,
    ORDER_STATUSES.PICKUP_OTP_VERIFIED,
    ORDER_STATUSES.RECEIVED_AT_VENDOR,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.GOING_FOR_PICKUP]: [
    ORDER_STATUSES.PICKUP_OTP_VERIFIED,
    ORDER_STATUSES.PICKED_UP,
    ORDER_STATUSES.RECEIVED_AT_VENDOR,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.PICKUP_OTP_VERIFIED]: [
    ORDER_STATUSES.PICKED_UP,
    ORDER_STATUSES.RECEIVED_AT_VENDOR,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.PICKED_UP]: [
    ORDER_STATUSES.RECEIVED_AT_VENDOR,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.RECEIVED_AT_VENDOR]: [
    ORDER_STATUSES.PROCESSING,
    ORDER_STATUSES.PACKED,
    ORDER_STATUSES.RECONCILIATION_PENDING,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.RECONCILIATION_PENDING]: [
    ORDER_STATUSES.PROCESSING,
    ORDER_STATUSES.RECONCILIATION_DISPUTED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.RECONCILIATION_DISPUTED]: [
    ORDER_STATUSES.RECONCILIATION_PENDING,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.PROCESSING]: [
    ORDER_STATUSES.PACKED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.PACKED]: [
    ORDER_STATUSES.DELIVERY_ASSIGNED,
    ORDER_STATUSES.OUT_FOR_DELIVERY,
    ORDER_STATUSES.DELIVERED, // Direct self-delivery bypass
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.DELIVERY_ASSIGNED]: [
    ORDER_STATUSES.OUT_FOR_DELIVERY,
    ORDER_STATUSES.DELIVERY_OTP_VERIFIED,
    ORDER_STATUSES.DELIVERED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.OUT_FOR_DELIVERY]: [
    ORDER_STATUSES.DELIVERY_OTP_VERIFIED,
    ORDER_STATUSES.DELIVERED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.DELIVERY_OTP_VERIFIED]: [
    ORDER_STATUSES.DELIVERED,
    ORDER_STATUSES.ADMIN_CANCELLED
  ],
  [ORDER_STATUSES.DELIVERED]: [
    ORDER_STATUSES.REFUNDED
  ],

  // Terminal states have no forward transitions
  [ORDER_STATUSES.PAYMENT_FAILED]: [],
  [ORDER_STATUSES.VENDOR_REJECTED]: [ORDER_STATUSES.REFUNDED],
  [ORDER_STATUSES.AUTO_REJECTED]: [ORDER_STATUSES.REFUNDED],
  [ORDER_STATUSES.CUSTOMER_CANCELLED]: [ORDER_STATUSES.REFUNDED],
  [ORDER_STATUSES.ADMIN_CANCELLED]: [ORDER_STATUSES.REFUNDED],
  [ORDER_STATUSES.REFUNDED]: []
}

// Maps status transition to allowed actor roles
const ROLE_RULES = {
  PAYMENT_CONFIRMED: ['SYSTEM', 'ADMIN', 'SUPER_ADMIN'],
  CUSTOMER_CANCELLED: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'],
  VENDOR_ACCEPTED: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  VENDOR_REJECTED: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  RECEIVED_AT_VENDOR: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  // PROCESSING is reachable both from RECEIVED_AT_VENDOR (vendor, no
  // reconciliation needed) and from RECONCILIATION_PENDING (customer,
  // via accept) — CUSTOMER is safe here because no customer-facing endpoint
  // ever attempts the RECEIVED_AT_VENDOR->PROCESSING transition directly.
  PROCESSING: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN', 'CUSTOMER'],
  PACKED: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  RECONCILIATION_PENDING: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  RECONCILIATION_DISPUTED: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'],

  // Delivery / Rider / Staff actions
  PICKUP_ASSIGNED: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM'],
  GOING_FOR_PICKUP: ['RIDER', 'VENDOR_RIDER', 'VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  PICKUP_OTP_VERIFIED: ['RIDER', 'VENDOR_RIDER', 'VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  PICKED_UP: ['RIDER', 'VENDOR_RIDER', 'VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  DELIVERY_ASSIGNED: ['VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM'],
  OUT_FOR_DELIVERY: ['RIDER', 'VENDOR_RIDER', 'VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  DELIVERY_OTP_VERIFIED: ['RIDER', 'VENDOR_RIDER', 'VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
  DELIVERED: ['RIDER', 'VENDOR_RIDER', 'VENDOR_OWNER', 'VENDOR_STAFF', 'ADMIN', 'SUPER_ADMIN'],

  // Admin/System actions
  WAITING_VENDOR_CONFIRMATION: ['SYSTEM', 'ADMIN', 'SUPER_ADMIN'],
  PAYMENT_FAILED: ['SYSTEM', 'ADMIN', 'SUPER_ADMIN'],
  AUTO_REJECTED: ['SYSTEM', 'ADMIN', 'SUPER_ADMIN'],
  ADMIN_CANCELLED: ['ADMIN', 'SUPER_ADMIN'],
  REFUNDED: ['FINANCE_ADMIN', 'SUPER_ADMIN', 'ADMIN']
}

/**
 * Validate order status transition
 * @param {string} currentStatus
 * @param {string} nextStatus
 * @param {string} actorRole
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateTransition(currentStatus, nextStatus, actorRole) {
  // If nextStatus is same as current, allow it (noop)
  if (currentStatus === nextStatus) {
    return { valid: true }
  }

  const allowedNext = TRANSITION_RULES[currentStatus] || []
  if (!allowedNext.includes(nextStatus)) {
    return {
      valid: false,
      message: `Invalid state transition: Cannot go from ${currentStatus} to ${nextStatus}`
    }
  }

  const allowedRoles = ROLE_RULES[nextStatus] || []
  const normalizedRole = actorRole?.toUpperCase()
  if (allowedRoles.length > 0 && !allowedRoles.includes(normalizedRole)) {
    return {
      valid: false,
      message: `Forbidden: Role ${actorRole} is not permitted to trigger transition to ${nextStatus}`
    }
  }

  return { valid: true }
}

/**
 * Record an order event in order_events (and order_status_history for compatibility) inside a transaction
 * @param {object} client - pg transaction client
 * @param {object} entry - { orderId, oldStatus, newStatus, actorId, actorRole, note, requestId }
 */
export async function recordOrderEvent(client, {
  orderId,
  oldStatus,
  newStatus,
  actorId,
  actorRole,
  note = null,
  requestId = null
}) {
  await client.query(
    `INSERT INTO order_events 
       (order_id, old_status, new_status, actor_id, actor_role, note, request_id, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [orderId, oldStatus, newStatus, actorId, actorRole, note, requestId]
  )

  await client.query(
    `INSERT INTO order_status_history 
       (order_id, from_status, to_status, changed_by, note, changed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [orderId, oldStatus, newStatus, actorId, note]
  )
}

/**
 * Assert that a state transition is valid — throws if not.
 * Use this in route handlers to guard transitions with a clear error.
 *
 * @param {string} currentStatus - Current order status
 * @param {string} nextStatus - Desired next status
 * @param {string} actorRole - Role of the actor performing the transition
 * @throws {{ statusCode: number, message: string, code: string }}
 */
export function assertTransition(currentStatus, nextStatus, actorRole) {
  const result = validateTransition(currentStatus, nextStatus, actorRole)
  if (!result.valid) {
    const err = new Error(result.message)
    err.statusCode = 409
    err.code = 'ORDER_STATE_INVALID'
    throw err
  }
}

/**
 * Canonical LNDRY order lifecycle (for documentation and Swagger enum generation).
 * Terminal states: CANCELLED, REFUNDED
 */
export const ORDER_LIFECYCLE = [
  'PAYMENT_PENDING',
  'WAITING_VENDOR_CONFIRMATION',
  'VENDOR_ACCEPTED',
  'PICKUP_ASSIGNED',
  'GOING_FOR_PICKUP',
  'PICKUP_OTP_VERIFIED',
  'PICKED_UP',
  'RECEIVED_AT_VENDOR',
  'RECONCILIATION_PENDING',
  'PROCESSING',
  'PACKED',
  'DELIVERY_ASSIGNED',
  'OUT_FOR_DELIVERY',
  'DELIVERY_OTP_VERIFIED',
  'DELIVERED',
]

export const TERMINAL_STATUSES = ['CANCELLED', 'REFUNDED']

/**
 * Convenience export — the "orderStateMachine" utility object referenced
 * by the LNDRY-API-001 contract.
 */
export const orderStateMachine = {
  ORDER_STATUSES,
  PROCESSING_STAGES,
  ORDER_LIFECYCLE,
  TERMINAL_STATUSES,
  validateTransition,
  assertTransition,
  recordOrderEvent,
}

