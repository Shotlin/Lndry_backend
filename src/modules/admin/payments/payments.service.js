import { AdminPaymentsRepository } from './payments.repository.js'

export class AdminPaymentsService {
  constructor(repository = new AdminPaymentsRepository()) {
    this.repository = repository
  }

  async findAll(filters) {
    const page = filters.page || 1
    const limit = filters.limit || 20
    const offset = (page - 1) * limit
    const result = await this.repository.findAll({ ...filters, offset, limit })
    return {
      payments: result.payments,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    }
  }
}
