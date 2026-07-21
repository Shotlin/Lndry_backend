import { AdminProductsService } from './products.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminProductsService()

export class AdminProductsController {
  async getAnalytics(request, reply) {
    const { page, limit, sortBy } = request.query
    const data = await svc.getAnalytics({ page, limit, sortBy })
    return success(data, 'Product analytics fetched')
  }

  async getDeadStock(request, reply) {
    const { days } = request.query
    const data = await svc.getDeadStock(days)
    return success(data, 'Dead stock garment_rates fetched')
  }

  async getLowMargin(request, reply) {
    const { threshold } = request.query
    const data = await svc.getLowMargin(threshold)
    return success(data, 'Low margin garment_rates fetched')
  }

  async exportProducts(request, reply) {
    const { format } = request.query
    const { buffer, contentType, filename } = await svc.exportProducts(format)
    reply.header('Content-Type', contentType)
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  }

  async bulkUpdate(request, reply) {
    const results = await svc.bulkUpdate(request.body.garment_rates, request.user.id, request.ip)
    return success({ updated: results }, `${results.length} garment_rates updated`)
  }

  async duplicate(request, reply) {
    const product = await svc.duplicate(request.params.id, request.user.id, request.ip)
    if (!product) return error('Product not found', 404)
    return success(product, 'Product duplicated')
  }

  async searchBarcode(request, reply) {
    const product = await svc.searchBarcode(request.params.code)
    if (!product) return error('Product not found', 404)
    return success(product, 'Product found')
  }
}
