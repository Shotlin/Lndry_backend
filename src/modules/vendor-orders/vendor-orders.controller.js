import { success, error } from '../../utils/apiResponse.js'

/**
 * Vendor Orders Controller — thin HTTP layer for vendor order management
 */
export class VendorOrdersController {
  constructor(service) {
    this.service = service
  }

  async listOrders(request, reply) {
    console.log('Inside listOrders controller', request.user.id, request.query)
    try {
      const result = await this.service.listOrders(request.user.id, request.query)
      console.log('listOrders result:', result.orders.length)
      return reply.send(success(result.orders, 'Vendor orders fetched', { pagination: result.pagination }))
    } catch (err) {
      console.error('listOrders Error:', err)
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async getOrder(request, reply) {
    try {
      const order = await this.service.getOrder(request.user.id, request.params.orderId)
      return reply.send(success(order, 'Order details fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async acceptOrder(request, reply) {
    try {
      const result = await this.service.acceptOrder(request.user.id, request.params.orderId)
      return reply.send(success(result, 'Order accepted'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async rejectOrder(request, reply) {
    try {
      const result = await this.service.rejectOrder(
        request.user.id,
        request.params.orderId,
        request.body?.reason
      )
      return reply.send(success(result, 'Order rejected'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async updateProcessingStage(request, reply) {
    try {
      const result = await this.service.updateProcessingStage(
        request.user.id,
        request.params.orderId,
        request.body.status,
        {
          deliverySlotLabel: request.body.delivery_slot_label,
          deliverySlotAt: request.body.delivery_slot_at,
        }
      )
      return reply.send(success(result, 'Processing stage updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async proposeReconciliation(request, reply) {
    try {
      const result = await this.service.proposeReconciliation(
        request.user.id,
        request.params.orderId,
        request.body
      )
      return reply.send(success(result, 'Recalculation submitted for customer approval'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async assignRider(request, reply) {
    try {
      const result = await this.service.assignSpecificEmployee(
        request.user.id,
        request.params.orderId,
        request.body.employee_id
      )
      return reply.send(success(result, 'Rider assigned'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }

  async getDashboardStats(request, reply) {
    try {
      const stats = await this.service.getDashboardStats(request.user.id)
      return reply.send(success(stats, 'Dashboard stats fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code || 'INTERNAL_ERROR'))
    }
  }
}
