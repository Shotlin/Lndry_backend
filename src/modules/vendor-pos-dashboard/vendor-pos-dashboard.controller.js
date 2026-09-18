import { success, error } from '../../utils/apiResponse.js'

export class VendorPosDashboardController {
  constructor(service) {
    this.service = service
  }

  async dashboard(request, reply) {
    const data = await this.service.dashboard(request.vendorId)
    return reply.code(200).send(success(data, 'POS dashboard fetched'))
  }

  async exportCsv(request, reply) {
    const { from, to } = request.query || {}
    if (!from || !to) return reply.code(400).send(error('from and to are required', 'VALIDATION_ERROR'))
    const csv = await this.service.exportCounterSalesCsv(request.vendorId, from, to)
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', `attachment; filename="counter-sales-${from}-to-${to}.csv"`)
    return reply.code(200).send(csv)
  }

  async search(request, reply) {
    const result = await this.service.search(request.vendorId, request.query?.q)
    if (!result.success) return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    return reply.code(200).send(success(result.results, 'Search results fetched'))
  }
}
