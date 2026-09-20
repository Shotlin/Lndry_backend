/**
 * Order lifecycle notification catalogue — every automatic notification the
 * platform sends about an order, with its built-in wording.
 *
 * The wording here is only the DEFAULT. An admin can override any of it from the
 * dashboard (stored in `notification_event_templates`), so wording can change
 * without a new app release; deleting the override restores what is written here.
 *
 * Placeholders use {{name}}. The backend fills them from real order data before
 * sending. Unknown placeholders are rejected when a template is saved.
 */

export const PLACEHOLDERS = {
  customerName: 'Customer\'s name',
  vendorName: 'Laundry partner name',
  captainName: 'Assigned captain\'s name',
  orderId: 'Order number, e.g. LNDR-20260920-7DE',
  pickupDate: 'Scheduled pickup date',
  pickupSlot: 'Scheduled pickup time slot',
  amount: 'Amount for this event (₹)',
  remainingAmount: 'Unpaid balance on the order (₹)',
  otp: 'The one-time code (OTP events only)',
  reason: 'Reason given (rejections / cancellations)',
}

const BASE = ['customerName', 'vendorName', 'orderId', 'pickupDate', 'pickupSlot', 'amount', 'remainingAmount']
const withCaptain = [...BASE, 'captainName']

/**
 * key → {
 *   group, label, trigger            what the admin sees
 *   recipient                        default recipient: CUSTOMER | VENDOR | CAPTAIN
 *   leg                              for a CAPTAIN recipient: which assignment ('PICKUP' | 'DELIVERY' | 'ANY')
 *   title, body                      default wording
 *   link                             default tap destination type (params are filled from the order)
 *   placeholders                     the placeholders this event can fill
 * }
 */
export const LIFECYCLE_EVENTS = {
  // ── Customer ────────────────────────────────────────────────────────────
  ORDER_PLACED: {
    group: 'Customer', label: 'Order placed', trigger: 'Order placed and sent to the laundry',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Order placed successfully 🎉',
    body: 'Your order {{orderId}} has been placed and sent to {{vendorName}} for confirmation.',
  },
  VENDOR_ACCEPTED: {
    group: 'Customer', label: 'Vendor accepted', trigger: 'Laundry accepts the order',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Your laundry order is confirmed ✅',
    body: '{{vendorName}} accepted your order. Pickup is scheduled for {{pickupDate}} at {{pickupSlot}}.',
  },
  VENDOR_REJECTED: {
    group: 'Customer', label: 'Vendor rejected', trigger: 'Laundry rejects, or does not respond in time',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: [...BASE, 'reason'],
    title: 'Your order could not be accepted',
    body: '{{vendorName}} couldn\'t take order {{orderId}}. Any payment will be refunded — you can choose another laundry.',
  },
  PICKUP_CAPTAIN_ASSIGNED: {
    group: 'Customer', label: 'Captain assigned for pickup', trigger: 'A captain is assigned to collect the laundry',
    recipient: 'CUSTOMER', link: 'order_tracking', placeholders: withCaptain,
    title: 'Pickup captain assigned 🛵',
    body: '{{captainName}} has been assigned to collect your laundry.',
  },
  CAPTAIN_ON_THE_WAY_PICKUP: {
    group: 'Customer', label: 'Captain on the way (pickup)', trigger: 'Captain starts heading to the pickup address',
    recipient: 'CUSTOMER', link: 'order_tracking', placeholders: withCaptain,
    title: 'Your captain is on the way 🛵',
    body: '{{captainName}} is heading to your pickup location.',
  },
  PICKUP_OTP: {
    group: 'Customer', label: 'Pickup OTP', trigger: 'Pickup OTP generated',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: [...BASE, 'otp'],
    title: 'Pickup OTP: {{otp}}',
    body: 'Share this OTP with the LNDRY captain only when your garments are collected.',
  },
  PICKED_UP: {
    group: 'Customer', label: 'Picked up', trigger: 'Captain collects the garments',
    recipient: 'CUSTOMER', link: 'order_tracking', placeholders: withCaptain,
    title: 'Laundry picked up ✅',
    body: 'Your garments have been collected and are heading to {{vendorName}}.',
  },
  REACHED_VENDOR: {
    group: 'Customer', label: 'Reached the laundry', trigger: 'Laundry receives the garments',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Your laundry reached the partner',
    body: '{{vendorName}} has received your garments and will verify the final quantity.',
  },
  REEVALUATION_REVIEW: {
    group: 'Customer', label: 'Re-evaluation — approval needed', trigger: 'Laundry changes the final quantity / price',
    recipient: 'CUSTOMER', link: 'order_approval', placeholders: BASE,
    title: 'Review your updated laundry details',
    body: '{{vendorName}} updated the final quantity or items. Please review and approve the revised order.',
  },
  PROCESSING_STARTED: {
    group: 'Customer', label: 'Processing started', trigger: 'Cleaning begins',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Cleaning started 🧺',
    body: '{{vendorName}} has started processing your laundry.',
  },
  PROCESSING_COMPLETED: {
    group: 'Customer', label: 'Processing completed', trigger: 'Cleaning finished, packed for delivery',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Your laundry is ready ✨',
    body: 'Cleaning is complete and your garments are being prepared for delivery.',
  },
  DELIVERY_CAPTAIN_ASSIGNED: {
    group: 'Customer', label: 'Captain assigned for delivery', trigger: 'A captain is assigned to deliver',
    recipient: 'CUSTOMER', link: 'order_tracking', placeholders: withCaptain,
    title: 'Delivery captain assigned 🛵',
    body: '{{captainName}} has been assigned to deliver your clean laundry.',
  },
  OUT_FOR_DELIVERY: {
    group: 'Customer', label: 'Out for delivery', trigger: 'Captain starts the delivery trip',
    recipient: 'CUSTOMER', link: 'order_tracking', placeholders: withCaptain,
    title: 'Your clean laundry is on the way 🚚',
    body: '{{captainName}} is heading to your delivery address.',
  },
  REMAINING_PAYMENT: {
    group: 'Customer', label: 'Remaining payment reminder', trigger: 'Delivery trip starts and a balance is still unpaid',
    recipient: 'CUSTOMER', link: 'order_payment', placeholders: BASE,
    title: '₹{{remainingAmount}} payment pending',
    body: 'Your laundry is on the way. Please complete the remaining payment before delivery.',
  },
  DELIVERY_OTP: {
    group: 'Customer', label: 'Delivery OTP', trigger: 'Delivery OTP generated',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: [...BASE, 'otp'],
    title: 'Delivery OTP: {{otp}}',
    body: 'Share this OTP only after receiving your laundry.',
  },
  DELIVERED: {
    group: 'Customer', label: 'Delivered', trigger: 'Order delivered',
    recipient: 'CUSTOMER', link: 'order_review', placeholders: BASE,
    title: 'Order delivered successfully 🎉',
    body: 'Your LNDRY order {{orderId}} has been delivered. Thank you for choosing LNDRY.',
  },
  BALANCE_PAID: {
    group: 'Customer', label: 'Payment received', trigger: 'A payment on the order is received',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Payment received ✅',
    body: 'We received ₹{{amount}} for order {{orderId}}.',
  },
  ORDER_CANCELLED: {
    group: 'Customer', label: 'Order cancelled', trigger: 'Order cancelled',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: [...BASE, 'reason'],
    title: 'Order cancelled',
    body: 'Your order {{orderId}} was cancelled.',
  },
  REFUND_UPDATE: {
    group: 'Customer', label: 'Refund update', trigger: 'Order refunded',
    recipient: 'CUSTOMER', link: 'order_details', placeholders: BASE,
    title: 'Refund update 💸',
    body: 'Your refund for order {{orderId}} is being processed.',
  },

  // ── Vendor (laundry partner) ────────────────────────────────────────────
  VENDOR_NEW_ORDER: {
    group: 'Vendor', label: 'New order received', trigger: 'A customer places an order with the laundry',
    recipient: 'VENDOR', link: 'order_details', placeholders: BASE,
    title: 'New order received 🧺',
    body: '{{customerName}} placed order {{orderId}}. Please accept or reject it.',
  },
  VENDOR_CAPTAIN_ASSIGNED: {
    group: 'Vendor', label: 'Captain assigned', trigger: 'A captain is assigned to pick up or deliver',
    recipient: 'VENDOR', link: 'order_details', placeholders: withCaptain,
    title: 'Captain assigned',
    body: '{{captainName}} was assigned to order {{orderId}}.',
  },
  VENDOR_PICKUP_COMPLETED: {
    group: 'Vendor', label: 'Pickup completed', trigger: 'Captain collects the customer\'s garments',
    recipient: 'VENDOR', link: 'order_details', placeholders: withCaptain,
    title: 'Pickup completed ✅',
    body: 'Order {{orderId}} was collected and is on its way to you.',
  },
  VENDOR_REEVAL_ACCEPTED: {
    group: 'Vendor', label: 'Customer approved re-evaluation', trigger: 'Customer approves the revised order',
    recipient: 'VENDOR', link: 'order_details', placeholders: BASE,
    title: 'Customer approved the update ✅',
    body: '{{customerName}} approved the revised order {{orderId}}. You can start processing.',
  },
  VENDOR_REEVAL_REJECTED: {
    group: 'Vendor', label: 'Customer rejected re-evaluation', trigger: 'Customer rejects the revised order',
    recipient: 'VENDOR', link: 'order_details', placeholders: BASE,
    title: 'Customer did not approve the update',
    body: '{{customerName}} did not approve the revised order {{orderId}}. Please review it.',
  },
  VENDOR_PAYMENT_UPDATE: {
    group: 'Vendor', label: 'Payment update', trigger: 'A payment on the order is received',
    recipient: 'VENDOR', link: 'order_details', placeholders: BASE,
    title: 'Payment received',
    body: '₹{{amount}} was received for order {{orderId}}.',
  },
  VENDOR_ORDER_ISSUE: {
    group: 'Vendor', label: 'Order cancelled / issue', trigger: 'Order cancelled after being placed',
    recipient: 'VENDOR', link: 'order_details', placeholders: [...BASE, 'reason'],
    title: 'Order cancelled',
    body: 'Order {{orderId}} was cancelled.',
  },

  // ── Captain (rider) ─────────────────────────────────────────────────────
  CAPTAIN_NEW_PICKUP: {
    group: 'Captain', label: 'New pickup assigned', trigger: 'Captain is assigned a pickup',
    recipient: 'CAPTAIN', leg: 'PICKUP', link: 'order_details', placeholders: BASE,
    title: 'New pickup assigned 🛵',
    body: 'Pickup for order {{orderId}} from {{customerName}}. Tap to see the details.',
  },
  CAPTAIN_NEW_DELIVERY: {
    group: 'Captain', label: 'New delivery assigned', trigger: 'Captain is assigned a delivery',
    recipient: 'CAPTAIN', leg: 'DELIVERY', link: 'order_details', placeholders: BASE,
    title: 'New delivery assigned 🚚',
    body: 'Deliver order {{orderId}} to {{customerName}}. Tap to see the details.',
  },
  CAPTAIN_JOB_CANCELLED: {
    group: 'Captain', label: 'Job cancelled', trigger: 'An order the captain was assigned to is cancelled',
    recipient: 'CAPTAIN', leg: 'ANY', link: 'order_details', placeholders: [...BASE, 'reason'],
    title: 'Job cancelled',
    body: 'Order {{orderId}} was cancelled. No pickup or delivery is needed.',
  },
  CAPTAIN_PAYMENT_COMPLETED: {
    group: 'Captain', label: 'Customer payment completed', trigger: 'Customer pays the remaining balance',
    recipient: 'CAPTAIN', leg: 'DELIVERY', link: 'order_details', placeholders: BASE,
    title: 'Customer payment received ✅',
    body: 'The customer paid ₹{{amount}} for order {{orderId}}. You can complete the delivery.',
  },
}

export const RECIPIENT_TYPES = ['CUSTOMER', 'VENDOR', 'CAPTAIN']

/** Statuses that finish an order without delivering it. */
export const CANCELLED_STATUSES = ['CUSTOMER_CANCELLED', 'ADMIN_CANCELLED']

/**
 * What each order status transition means for notifications:
 * status → [{ event, dedupe }] where `dedupe` says what makes one send distinct
 * (default: once per order for that event).
 */
export const STATUS_EVENTS = {
  WAITING_VENDOR_CONFIRMATION: [{ event: 'ORDER_PLACED' }, { event: 'VENDOR_NEW_ORDER' }],
  VENDOR_ACCEPTED: [{ event: 'VENDOR_ACCEPTED' }],
  VENDOR_REJECTED: [{ event: 'VENDOR_REJECTED' }],
  AUTO_REJECTED: [{ event: 'VENDOR_REJECTED', reason: 'The laundry did not respond in time.' }],
  PICKUP_ASSIGNED: [{ event: 'PICKUP_CAPTAIN_ASSIGNED' }, { event: 'CAPTAIN_NEW_PICKUP' }, { event: 'VENDOR_CAPTAIN_ASSIGNED', leg: 'PICKUP' }],
  GOING_FOR_PICKUP: [{ event: 'CAPTAIN_ON_THE_WAY_PICKUP' }],
  PICKUP_OTP_VERIFIED: [{ event: 'PICKED_UP' }, { event: 'VENDOR_PICKUP_COMPLETED' }],
  PICKED_UP: [{ event: 'PICKED_UP' }, { event: 'VENDOR_PICKUP_COMPLETED' }],
  RECEIVED_AT_VENDOR: [{ event: 'REACHED_VENDOR' }],
  RECONCILIATION_PENDING: [{ event: 'REEVALUATION_REVIEW', perReconciliation: true }],
  PROCESSING: [{ event: 'PROCESSING_STARTED' }, { event: 'VENDOR_REEVAL_ACCEPTED', onlyFrom: 'RECONCILIATION_PENDING', perReconciliation: true }],
  RECONCILIATION_DISPUTED: [{ event: 'VENDOR_REEVAL_REJECTED', perReconciliation: true }],
  PACKED: [{ event: 'PROCESSING_COMPLETED' }],
  DELIVERY_ASSIGNED: [{ event: 'DELIVERY_CAPTAIN_ASSIGNED' }, { event: 'CAPTAIN_NEW_DELIVERY' }, { event: 'VENDOR_CAPTAIN_ASSIGNED', leg: 'DELIVERY' }],
  OUT_FOR_DELIVERY: [{ event: 'OUT_FOR_DELIVERY' }, { event: 'REMAINING_PAYMENT', onlyIfBalanceDue: true }],
  DELIVERY_OTP_VERIFIED: [{ event: 'DELIVERED' }],
  DELIVERED: [{ event: 'DELIVERED' }],
  CUSTOMER_CANCELLED: [{ event: 'ORDER_CANCELLED' }, { event: 'VENDOR_ORDER_ISSUE' }, { event: 'CAPTAIN_JOB_CANCELLED' }],
  ADMIN_CANCELLED: [{ event: 'ORDER_CANCELLED' }, { event: 'VENDOR_ORDER_ISSUE' }, { event: 'CAPTAIN_JOB_CANCELLED' }],
  REFUNDED: [{ event: 'REFUND_UPDATE' }],
}
