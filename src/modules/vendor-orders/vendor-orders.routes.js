import { VendorOrdersController } from './vendor-orders.controller.js'
import { VendorOrdersService } from './vendor-orders.service.js'

/**
 * Vendor Orders routes plugin
 * Prefix: /api/v1/vendor-orders
 *
 * All routes require authentication. The service layer resolves vendor ownership
 * from the authenticated user (vendor owner or employee).
 *
 * Endpoints:
 *   GET    /                             — List vendor orders (with status filter)
 *   GET    /stats                        — Vendor dashboard stats
 *   GET    /:orderId                     — Get order detail
 *   POST   /:orderId/accept              — Accept order (→ VENDOR_ACCEPTED)
 *   POST   /:orderId/reject              — Reject order (→ VENDOR_REJECTED)
 *   POST   /:orderId/processing-stage    — Update processing stage
 *   POST   /:orderId/reconcile           — Propose recalculation (staged, pending customer approval)
 */
export default async function vendorOrdersRoutes(fastify) {
  const service = new VendorOrdersService({ fastify })
  const controller = new VendorOrdersController(service)

  // All routes require authentication
  fastify.addHook('preHandler', fastify.authenticate)

  // Riders get their own restricted surface at /vendor/rider/jobs — block
  // them from the full vendor order-management API. Without this, a
  // rider's shop-scoped JWT (issued by the same login flow as any other
  // vendor employee) could otherwise call every order-management endpoint
  // here, defeating the point of a "restricted view."
  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({
        success: false,
        message: 'Riders use /api/v1/vendor/rider/jobs, not vendor order management',
        code: 'FORBIDDEN',
      })
    }
  })

  const orderIdParams = {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' }
    }
  }

  // GET / — List vendor orders
  fastify.get('/', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'List orders for this vendor',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [
              'WAITING_VENDOR_CONFIRMATION', 'VENDOR_ACCEPTED',
              'PICKUP_ASSIGNED', 'GOING_FOR_PICKUP', 'PICKUP_OTP_VERIFIED', 'PICKED_UP',
              'RECEIVED_AT_VENDOR', 'RECONCILIATION_PENDING', 'RECONCILIATION_DISPUTED',
              'WASHING', 'DRYING', 'IRONING', 'PACKED',
              'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERY_OTP_VERIFIED', 'DELIVERED',
              'VENDOR_REJECTED', 'AUTO_REJECTED', 'CUSTOMER_CANCELLED', 'ADMIN_CANCELLED', 'REFUNDED'
            ]
          },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      }
    }
  }, controller.listOrders.bind(controller))

  // GET /stats — Dashboard stats
  fastify.get('/stats', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Get vendor dashboard order statistics',
      security: [{ bearerAuth: [] }]
    }
  }, controller.getDashboardStats.bind(controller))

  // GET /:orderId — Order detail
  fastify.get('/:orderId', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Get vendor order details',
      security: [{ bearerAuth: [] }],
      params: orderIdParams
    }
  }, controller.getOrder.bind(controller))

  // POST /:orderId/accept — Accept order
  fastify.post('/:orderId/accept', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Vendor accepts order',
      security: [{ bearerAuth: [] }],
      params: orderIdParams
    }
  }, controller.acceptOrder.bind(controller))

  // POST /:orderId/reject — Reject order
  fastify.post('/:orderId/reject', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Vendor rejects order',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, controller.rejectOrder.bind(controller))

  // POST /:orderId/assign-rider — Manually assign/reassign a specific
  // rider or staff member (Phase 1 of the rider-assignment initiative)
  fastify.post('/:orderId/assign-rider', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Manually assign a specific rider/staff to this order',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['employee_id'],
        properties: {
          employee_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.assignRider.bind(controller))

  // POST /:orderId/offer-rider — Offer (not directly assign) a specific
  // rider/staff — they must accept before it's confirmed theirs (Phase 2
  // of the rider-assignment initiative)
  fastify.post('/:orderId/offer-rider', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Offer this order to a specific rider/staff, pending their acceptance',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['employee_id'],
        properties: {
          employee_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.offerRider.bind(controller))

  // POST /:orderId/broadcast-rider — Broadcast to every active rider at
  // once; first to accept wins (Phase 3 of the rider-assignment initiative)
  fastify.post('/:orderId/broadcast-rider', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Broadcast this order to every active rider — first to accept wins',
      security: [{ bearerAuth: [] }],
      params: orderIdParams
    }
  }, controller.broadcastRider.bind(controller))

  // POST /:orderId/processing-stage — Update processing stage
  fastify.post('/:orderId/processing-stage', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Update order processing stage (WASHING, DRYING, IRONING, PACKED)',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['RECEIVED_AT_VENDOR', 'WASHING', 'DRYING', 'IRONING', 'PACKED']
          },
          // Only meaningful when status === 'PACKED' — the vendor's chosen
          // dispatch time for the delivery leg, shown on the rider's job
          // card. Distinct from the customer's checkout-time slot.
          delivery_slot_label: { type: 'string', maxLength: 100 },
          delivery_slot_at: { type: 'string', format: 'date-time' }
        }
      }
    }
  }, controller.updateProcessingStage.bind(controller))

  // POST /:orderId/reconcile — Vendor's authoritative recalculation, staged
  // pending customer approval (does not apply immediately)
  fastify.post('/:orderId/reconcile', {
    schema: {
      tags: ['Vendor Orders'],
      summary: 'Propose a recalculated garment count/weight for customer approval',
      security: [{ bearerAuth: [] }],
      params: orderIdParams,
      body: {
        type: 'object',
        required: ['photo_urls'],
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['order_line_id'],
              properties: {
                order_line_id: { type: 'string', format: 'uuid' },
                confirmed_quantity: { type: 'integer', minimum: 0 },
                // Reclassify this line to a different service the vendor
                // actually offers (e.g. moving a delicate item from a
                // per-kg wash to a per-piece dry-clean service). Resolved
                // server-side against this vendor's own active rates.
                new_garment_type_id: { type: 'string', format: 'uuid' }
              }
            }
          },
          // Exact decimal weight (kg) or area (sq ft) for this order's
          // continuous-unit line, e.g. 1.2 — piece-priced lines never use
          // this, they go through `lines[].confirmed_quantity` above.
          confirmed_weight_kg: { type: 'number', minimum: 0.1 },
          // A service that wasn't on the order at all — a genuine addition,
          // or the destination for a partial quantity moved out of an
          // existing line (reduce that line via confirmed_quantity/
          // confirmed_weight_kg above, then add the moved garments here
          // under whatever service/quantity they actually belong to).
          // garment_type_id resolved server-side against this vendor's own
          // active rates, same as lines[].new_garment_type_id.
          new_lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['garment_type_id', 'quantity'],
              properties: {
                garment_type_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'number', exclusiveMinimum: 0 }
              }
            }
          },
          adjustment_reason: { type: 'string', maxLength: 500 },
          photo_urls: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' }
          },
          // Structured "report a problem" annotations (damaged item, item
          // not applicable to this service, etc.) attached to specific
          // lines on this order — see reconciliation-problem-types module.
          // Purely evidentiary: the actual price change still comes from
          // lines[]/confirmed_weight_kg/new_garment_type_id above.
          problems: {
            type: 'array',
            items: {
              type: 'object',
              required: ['order_line_id', 'photo_urls'],
              properties: {
                order_line_id: { type: 'string', format: 'uuid' },
                // Omit for "Other" — custom_message is required in that case.
                problem_type_id: { type: 'string', format: 'uuid' },
                custom_message: { type: 'string', maxLength: 500 },
                photo_urls: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 3,
                  items: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, controller.proposeReconciliation.bind(controller))
}
