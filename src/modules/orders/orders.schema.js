/**
 * Orders JSON schemas for request/response validation
 */

const orderItemSchema = {
  type: 'object',
  properties: {
    productId: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    price: { type: 'number' },
    quantity: { type: 'integer' },
    unit: { type: 'string' },
    total: { type: 'number' },
    thumbnailUrl: { type: ['string', 'null'] },
  },
}

const timelineItemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    status: { type: 'string' },
    message: { type: ['string', 'null'] },
    timestamp: { type: ['string', 'null'] },
  },
}

const trackingSchema = {
  type: 'object',
  properties: {
    rider: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        phone: { type: 'string' },
      },
    },
    riderLocation: {
      type: ['object', 'null'],
      properties: {
        lat: { type: ['number', 'null'] },
        lng: { type: ['number', 'null'] },
        timestamp: { type: ['string', 'null'] },
      },
    },
    destination: {
      type: 'object',
      properties: {
        lat: { type: ['number', 'null'] },
        lng: { type: ['number', 'null'] },
        addressLine1: { type: 'string' },
        addressLine2: { type: 'string' },
        landmark: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        pincode: { type: 'string' },
      },
    },
  },
}

const orderResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    orderNumber: { type: 'string' },
    shopId: { type: ['string', 'null'] },
    vendorName: { type: ['string', 'null'] },
    status: { type: 'string' },
    items: { type: 'array', items: orderItemSchema },
    subtotal: { type: 'number' },
    discountAmount: { type: 'number' },
    deliveryFee: { type: 'number' },
    platformFee: { type: 'number' },
    taxAmount: { type: 'number' },
    totalAmount: { type: 'number' },
    paymentMethod: { type: 'string' },
    paymentStatus: { type: 'string' },
    couponCode: { type: ['string', 'null'] },
    deliveryAddress: { type: 'object' },
    deliveryNotes: { type: ['string', 'null'] },
    handlingFee: { type: 'number' },
    lateNightFee: { type: 'number' },
    tipAmount: { type: 'number' },
    deliveryInstructions: { type: ['string', 'null'] },
    savingsTotal: { type: 'number' },
    estimatedDelivery: { type: ['string', 'null'] },
    deliveredAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    riderId: { type: ['string', 'null'] },
    riderName: { type: ['string', 'null'] },
    riderPhone: { type: ['string', 'null'] },
    // Delivery slot fields
    deliveryMode: { type: 'string', enum: ['ASAP', 'SCHEDULED'] },
    scheduledDeliveryAt: { type: ['string', 'null'] },
    scheduledSlotStart: { type: ['string', 'null'] },
    scheduledSlotEnd: { type: ['string', 'null'] },
    scheduledSlotLabel: { type: ['string', 'null'] },
    // Pickup slot fields — computed by OrdersRepository._format() /
    // joined from vendor_slots, but omitted here until now, which meant
    // fast-json-stringify silently stripped them before the app ever saw
    // them (same class of bug flagged above for the reconciliation fields).
    vendorSlotId: { type: ['string', 'null'] },
    pickupDate: { type: ['string', 'null'] },
    pickupSlotStartTime: { type: ['string', 'null'] },
    pickupSlotEndTime: { type: ['string', 'null'] },
    isExpressPickup: { type: 'boolean' },
    timeline: { type: 'array', items: timelineItemSchema },
    tracking: trackingSchema,
    // Advance-payment + rider/vendor reconciliation feature — these are
    // computed by _enrichCustomerOrder but were missing here, which meant
    // fast-json-stringify silently stripped them from every response before
    // the app ever saw them (same class of bug as the historical
    // garment-types cost_price incident).
    amountPaidPaise: { type: 'number' },
    deliveryFeePaise: { type: 'number' },
    platformFeePaise: { type: 'number' },
    // Full payment history (ADVANCE + BALANCE legs, oldest first) — see the
    // comment on _enrichCustomerOrder. Declared explicitly for the exact
    // reason amountPaidPaise is above it: fast-json-stringify silently
    // strips any computed field missing from this schema.
    payments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          purpose: { type: 'string', enum: ['ADVANCE', 'BALANCE', 'FULL'] },
          method: { type: ['string', 'null'] },
          status: { type: 'string' },
          amountPaise: { type: 'number' },
          createdAt: { type: 'string' },
        },
      },
    },
    riderReevaluation: { type: ['object', 'null'], additionalProperties: true },
    vendorReevaluation: { type: ['object', 'null'], additionalProperties: true },
  },
}

export const placeOrderSchema = {
  tags: ['Orders'],
  summary: 'Place a new order from cart',
  body: {
    oneOf: [
      {
        type: 'object',
        required: ['addressId', 'paymentMethod', 'vendorSlotId', 'pickupDate'],
        properties: {
          addressId: { type: 'string', format: 'uuid' },
          paymentMethod: { type: 'string', enum: ['COD', 'ONLINE', 'WALLET'] },
          vendorSlotId: { type: 'string', format: 'uuid' },
          pickupDate: { type: 'string', format: 'date' },
          couponCode: {
            oneOf: [
              { type: 'string', minLength: 1, maxLength: 50 },
              { type: 'null' },
            ],
          },
          deliveryNotes: { type: 'string', maxLength: 500 },
          tipAmount: { type: 'number', minimum: 0, maximum: 500 },
          deliveryInstructions: { type: ['string', 'null'], maxLength: 200 },
          handlingFee: { type: 'number', minimum: 0 },
          lateNightFee: { type: 'number', minimum: 0 },
          savingsTotal: { type: 'number', minimum: 0 },
          deliveryMode: { type: 'string', enum: ['ASAP', 'SCHEDULED'] },
          scheduledDeliveryAt: { type: ['string', 'null'] },
          scheduledSlotStart: { type: ['string', 'null'] },
          scheduledSlotEnd: { type: ['string', 'null'] },
          scheduledSlotLabel: { type: ['string', 'null'], maxLength: 100 },
        },
      },
      {
        type: 'object',
        required: ['order_draft_id'],
        properties: {
          order_draft_id: { type: 'string', format: 'uuid' },
          orderDraftId: { type: 'string', format: 'uuid' },
          payment_method: { type: 'string', enum: ['COD', 'ONLINE'] },
          paymentMethod: { type: 'string', enum: ['COD', 'ONLINE'] }
        }
      },
      {
        type: 'object',
        required: ['orderDraftId'],
        properties: {
          order_draft_id: { type: 'string', format: 'uuid' },
          orderDraftId: { type: 'string', format: 'uuid' },
          payment_method: { type: 'string', enum: ['COD', 'ONLINE'] },
          paymentMethod: { type: 'string', enum: ['COD', 'ONLINE'] }
        }
      }
    ]
  },
  response: {
    201: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            orders: { type: 'array', items: orderResponseSchema },
            order:  orderResponseSchema,
          },
        },
      },
    },
  },
}

export const listOrdersSchema = {
  tags: ['Orders'],
  summary: 'List user orders (paginated)',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      status: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: orderResponseSchema },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
  },
}

export const getOrderSchema = {
  tags: ['Orders'],
  summary: 'Get order details by ID',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: orderResponseSchema,
      },
    },
  },
}

export const activeOrderSchema = {
  tags: ['Orders'],
  summary: 'Get active (in-progress) order',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: orderResponseSchema,
      },
    },
  },
}

export const cancelOrderSchema = {
  tags: ['Orders'],
  summary: 'Cancel an order',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 500 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
}

export const reorderSchema = {
  tags: ['Orders'],
  summary: 'Prepare a reorder from a past order (validated against current vendor data)',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        // Every field is listed: the server strips anything undeclared.
        data: {
          type: 'object',
          properties: {
            vendorId: { type: 'string' },
            vendorName: { type: 'string' },
            itemCount: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  serviceId: { type: 'string' },
                  name: { type: 'string' },
                  unit: { type: 'string' },
                  quantity: { type: 'integer' },
                  ratePaise: { type: 'integer' },
                },
              },
            },
            unavailable: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, reason: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}

// ─── Admin Schemas ─────────────────────────────────────

export const adminListOrdersSchema = {
  tags: ['Orders', 'Admin'],
  summary: 'List all orders (admin, paginated)',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      status: { type: 'string' },
      userId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: orderResponseSchema },
        pagination: { type: 'object' },
      },
    },
  },
}

export const adminUpdateStatusSchema = {
  tags: ['Orders', 'Admin'],
  summary: 'Update order status',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['WAITING_VENDOR_CONFIRMATION', 'CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: orderResponseSchema,
      },
    },
  },
}

export const adminAssignRiderSchema = {
  tags: ['Orders', 'Admin'],
  summary: 'Assign a rider to an order',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['riderId'],
    properties: {
      riderId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: orderResponseSchema,
      },
    },
  },
}

export const prepareOrderSchema = {
  tags: ['Orders'],
  summary: 'Prepare an order draft before payment',
  body: {
    // slot_id is required unless is_express_pickup is true — express
    // pickup bypasses the vendor_slots system entirely (validated in
    // orders.service.js#prepareOrder, not expressible in JSON Schema).
    type: 'object',
    required: ['quote_id', 'address_id'],
    properties: {
      quote_id: { type: 'string', format: 'uuid' },
      address_id: { type: 'string', format: 'uuid' },
      slot_id: { type: 'string', format: 'uuid' },
      coupon_code: { type: 'string', minLength: 1, maxLength: 50 },
      is_express_pickup: { type: 'boolean' }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            order_draft_id: { type: 'string', format: 'uuid' },
            payable_amount_paise: { type: 'integer' },
            snapshot: { type: 'object', additionalProperties: true }
          }
        }
      }
    }
  }
}
