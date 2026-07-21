import { success, error } from '../../../utils/apiResponse.js'

export class AdminOrdersController {
  constructor(service) {
    this.service = service
  }

  async findAll(request, reply) {
    const data = await this.service.findAll(request.query)
    return reply.send(success(data, 'Orders fetched'))
  }

  async getStatsByStatus(request, reply) {
    const data = await this.service.getStatsByStatus()
    return reply.send(success(data, 'Order stats by status'))
  }

  async findById(request, reply) {
    try {
      const data = await this.service.findById(request.params.id)
      return reply.send(success(data, 'Order details'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async updateStatus(request, reply) {
    try {
      const { status, note } = request.body
      const data = await this.service.updateStatus(request.params.id, status, request.user.id, note, request.ip)
      return reply.send(success(data, 'Order status updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async assignRider(request, reply) {
    try {
      const { riderId } = request.body
      const data = await this.service.assignRider(request.params.id, riderId, request.user.id, request.ip)
      return reply.send(success(data, 'Rider assigned'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkAssign(request, reply) {
    try {
      const data = await this.service.bulkAssign(request.body.assignments, request.user.id, request.ip)
      return reply.send(success(data, 'Bulk assignment done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async createManualOrder(request, reply) {
    try {
      const data = await this.service.createManualOrder(request.body, request.user.id, request.ip)
      return reply.code(201).send(success(data, 'Manual order created'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getInvoice(request, reply) {
    try {
      const buffer = await this.service.getInvoice(request.params.id)
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename=invoice-${request.params.id}.pdf`).send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getPackingSlip(request, reply) {
    try {
      const data = await this.service.getPackingSlip(request.params.id)
      return reply.send(success(data, 'Packing slip'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async exportCSV(request, reply) {
    try {
      const buffer = await this.service.exportCSV(request.query)
      return reply.type('text/csv').header('Content-Disposition', 'attachment; filename=orders-export.csv').send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async refundOrder(request, reply) {
    try {
      const data = await this.service.refundOrder(
        request.params.id,
        request.body || {},
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Order refunded'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async cancelOrder(request, reply) {
    try {
      const data = await this.service.cancelOrder(
        request.params.id,
        request.body || {},
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Order cancelled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkUpdateStatus(request, reply) {
    try {
      const { orderIds, status } = request.body
      const data = await this.service.bulkUpdateStatus(orderIds, status, request.user.id, request.ip)
      return reply.send(success(data, 'Bulk status update done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }
}
