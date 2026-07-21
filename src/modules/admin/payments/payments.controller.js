import { success } from '../../../utils/apiResponse.js'
import { AdminPaymentsService } from './payments.service.js'

export class AdminPaymentsController {
  constructor(service = new AdminPaymentsService()) {
    this.service = service
  }

  async findAll(request, reply) {
    const data = await this.service.findAll(request.query)
    return reply.send(success(data, 'Payments fetched'))
  }
}
